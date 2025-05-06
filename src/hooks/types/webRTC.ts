export interface UseWebRTCProps {
  roomId: string;
}

export interface PeerStreamData {
  stream?: MediaStream;
  isSharing?: boolean;
  mediaType?: 'screen' | 'camera';
  streamReady?: boolean;
}

export interface PeerConnections {
  [peerId: string]: RTCPeerConnection;
}

export interface StreamSenders {
  [peerId: string]: RTCRtpSender[];
}

export interface UseWebRTCResult {
  isConnected: boolean;
  isConnecting: boolean;
  isLoading: boolean;
  error: string | null;
  clearError: () => void;
  peers: string[];
  localStream: MediaStream | null;
  peerStreams: Record<string, MediaStream>;
  peerStreamsWithData: Record<string, PeerStreamData>;
  selectedStream: string | null;
  selectStream: (streamId: string | null) => void;
  shareScreen: () => Promise<MediaStream | null>;
  stopSharing: () => void;
  userId: string;
  requestStream: (peerId: string) => void;
}
