class VoiceChat {
  constructor({ onStatusChange, onPeersChange, onMicLevel, onRemoteStream, onRemoteStreamRemoved }) {
    this.onStatusChange = onStatusChange;
    this.onPeersChange = onPeersChange;
    this.onMicLevel = onMicLevel;
    this.onRemoteStream = onRemoteStream;
    this.onRemoteStreamRemoved = onRemoteStreamRemoved;
    this.peerConnections = new Map();
    this.remoteStreams = new Map();
    this.localStream = null;
    this.screenStream = null;
    this.signalingSocket = null;
    this.roomId = null;
    this.peerId = null;
    this.muted = false;
    this.analyser = null;
    this.animationFrame = null;
    this.rtcConfig = {
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    };
  }

  async join(roomId, deviceId) {
    if (!roomId) {
      throw new Error('Room id is required');
    }
    if (this.signalingSocket) {
      await this.leave();
    }
    this.roomId = roomId;
    this.peerId = this.createPeerId();
    this.setStatus('connecting');

    this.localStream = await navigator.mediaDevices.getUserMedia({
      audio: deviceId ? { deviceId: { exact: deviceId } } : true,
      video: false,
    });
    this.localStream.getAudioTracks().forEach((track) => {
      track.enabled = true;
    });
    this.muted = false;

    this.startAnalyser();

    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const wsUrl = `${protocol}://${window.location.host}/signaling`;
    this.signalingSocket = new WebSocket(wsUrl);

    this.signalingSocket.addEventListener('open', () => {
      this.setStatus('connected');
      this.send({ type: 'join', roomId: this.roomId, peerId: this.peerId });
    });

    this.signalingSocket.addEventListener('close', () => {
      this.setStatus('disconnected');
      this.cleanupConnections();
    });

    this.signalingSocket.addEventListener('message', async (event) => {
      let payload;
      try {
        payload = JSON.parse(event.data);
      } catch (error) {
        return;
      }

      if (payload.type === 'peers') {
        payload.peers.forEach((peer) => this.createPeerConnection(peer, true));
        this.updatePeers();
      }

      if (payload.type === 'peer_joined') {
        this.createPeerConnection(payload.peerId, true);
        this.updatePeers();
      }

      if (payload.type === 'peer_left') {
        this.removePeer(payload.peerId);
        this.updatePeers();
      }

      if (payload.type === 'offer') {
        await this.handleOffer(payload.from, payload.data);
      }

      if (payload.type === 'answer') {
        await this.handleAnswer(payload.from, payload.data);
      }

      if (payload.type === 'ice') {
        await this.handleIce(payload.from, payload.data);
      }
    });
  }

  async leave() {
    if (this.signalingSocket) {
      this.signalingSocket.close();
    }
    this.cleanupConnections();
    this.stopAnalyser();
    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => track.stop());
    }
    if (this.screenStream) {
      this.screenStream.getTracks().forEach((track) => track.stop());
    }
    this.localStream = null;
    this.screenStream = null;
    this.signalingSocket = null;
    this.roomId = null;
    this.peerId = null;
    this.setStatus('disconnected');
  }

  async toggleMute() {
    if (!this.localStream) return;
    this.muted = !this.muted;
    this.localStream.getAudioTracks().forEach((track) => {
      track.enabled = !this.muted;
    });
    return this.muted;
  }

  async setInputDevice(deviceId) {
    if (!deviceId) return;
    const newStream = await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: { exact: deviceId } },
      video: false,
    });
    const newTrack = newStream.getAudioTracks()[0];
    const oldTracks = this.localStream ? this.localStream.getAudioTracks() : [];
    if (oldTracks.length > 0) {
      oldTracks[0].stop();
      this.localStream.removeTrack(oldTracks[0]);
    }
    this.localStream = this.localStream || new MediaStream();
    this.localStream.addTrack(newTrack);
    this.replaceTrackForPeers(newTrack, 'audio');
    this.startAnalyser();
    if (this.muted) {
      newTrack.enabled = false;
    }
  }

  async startScreenShare() {
    if (this.screenStream) return;
    this.screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
    const videoTrack = this.screenStream.getVideoTracks()[0];
    if (!videoTrack) return;
    this.replaceTrackForPeers(videoTrack, 'video');
    videoTrack.addEventListener('ended', () => {
      this.stopScreenShare();
    });
  }

  stopScreenShare() {
    if (!this.screenStream) return;
    this.screenStream.getTracks().forEach((track) => track.stop());
    this.screenStream = null;
    this.replaceTrackForPeers(null, 'video');
  }

  async listInputDevices() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((device) => device.kind === 'audioinput');
  }

  replaceTrackForPeers(track, kind) {
    this.peerConnections.forEach((pc) => {
      const sender = pc.getSenders().find((item) => item.track && item.track.kind === kind);
      if (sender) {
        if (track) {
          sender.replaceTrack(track);
        } else {
          sender.replaceTrack(null);
        }
        return;
      }
      if (track) {
        pc.addTrack(track, this.getStreamForTrack(track));
      }
    });
  }

  getStreamForTrack(track) {
    if (track.kind === 'audio') {
      return this.localStream;
    }
    if (track.kind === 'video') {
      return this.screenStream;
    }
    return new MediaStream([track]);
  }

  createPeerConnection(peerId, isInitiator) {
    if (!peerId || this.peerConnections.has(peerId)) return;
    const pc = new RTCPeerConnection(this.rtcConfig);
    this.peerConnections.set(peerId, pc);

    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => pc.addTrack(track, this.localStream));
    }
    if (this.screenStream) {
      this.screenStream.getTracks().forEach((track) => pc.addTrack(track, this.screenStream));
    }

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.send({ type: 'ice', target: peerId, data: event.candidate });
      }
    };

    pc.ontrack = (event) => {
      const [stream] = event.streams;
      if (!stream) return;
      this.remoteStreams.set(peerId, stream);
      if (this.onRemoteStream) {
        this.onRemoteStream(peerId, stream);
      }
    };

    pc.onconnectionstatechange = () => {
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
        this.removePeer(peerId);
        this.updatePeers();
      }
    };

    if (isInitiator) {
      pc.createOffer()
        .then((offer) => pc.setLocalDescription(offer))
        .then(() => {
          this.send({ type: 'offer', target: peerId, data: pc.localDescription });
        })
        .catch(() => {});
    }
  }

  async handleOffer(from, data) {
    if (!from) return;
    if (!this.peerConnections.has(from)) {
      this.createPeerConnection(from, false);
    }
    const pc = this.peerConnections.get(from);
    if (!pc) return;
    await pc.setRemoteDescription(new RTCSessionDescription(data));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    this.send({ type: 'answer', target: from, data: pc.localDescription });
  }

  async handleAnswer(from, data) {
    const pc = this.peerConnections.get(from);
    if (!pc) return;
    await pc.setRemoteDescription(new RTCSessionDescription(data));
  }

  async handleIce(from, data) {
    const pc = this.peerConnections.get(from);
    if (!pc || !data) return;
    try {
      await pc.addIceCandidate(new RTCIceCandidate(data));
    } catch (error) {
      // ignore
    }
  }

  removePeer(peerId) {
    const pc = this.peerConnections.get(peerId);
    if (pc) {
      pc.close();
      this.peerConnections.delete(peerId);
    }
    const stream = this.remoteStreams.get(peerId);
    if (stream) {
      if (this.onRemoteStreamRemoved) {
        this.onRemoteStreamRemoved(peerId);
      }
      this.remoteStreams.delete(peerId);
    }
  }

  cleanupConnections() {
    this.peerConnections.forEach((pc) => pc.close());
    this.peerConnections.clear();
    this.remoteStreams.clear();
    if (this.onRemoteStreamRemoved) {
      this.onRemoteStreamRemoved();
    }
  }

  send(payload) {
    if (this.signalingSocket && this.signalingSocket.readyState === WebSocket.OPEN) {
      this.signalingSocket.send(JSON.stringify(payload));
    }
  }

  setStatus(status) {
    if (this.onStatusChange) {
      this.onStatusChange(status);
    }
  }

  updatePeers() {
    if (this.onPeersChange) {
      this.onPeersChange(this.peerConnections.size);
    }
  }

  startAnalyser() {
    if (!this.localStream) return;
    this.stopAnalyser();
    const audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(this.localStream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    this.analyser = { analyser, dataArray, audioContext };
    const update = () => {
      if (!this.analyser) return;
      analyser.getByteFrequencyData(dataArray);
      const avg = dataArray.reduce((sum, value) => sum + value, 0) / dataArray.length;
      const level = Math.min(avg / 255, 1);
      if (this.onMicLevel) {
        this.onMicLevel(level);
      }
      this.animationFrame = requestAnimationFrame(update);
    };
    update();
  }

  stopAnalyser() {
    if (this.animationFrame) {
      cancelAnimationFrame(this.animationFrame);
    }
    if (this.analyser?.audioContext) {
      this.analyser.audioContext.close();
    }
    this.analyser = null;
    this.animationFrame = null;
    if (this.onMicLevel) {
      this.onMicLevel(0);
    }
  }

  createPeerId() {
    if (window.crypto?.randomUUID) {
      return window.crypto.randomUUID();
    }
    return `peer-${Math.random().toString(36).slice(2, 10)}`;
  }
}

window.VoiceChat = VoiceChat;
