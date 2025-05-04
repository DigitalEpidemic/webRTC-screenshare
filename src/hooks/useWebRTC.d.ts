interface PeerStreams {
  [peerId: string]: MediaStream | null;
}

interface UseWebRTCProps {
  roomId: string;
}

interface UseWebRTCResult {
  isConnected: boolean;
  isLoading: boolean;
  error: string | null;
  peers: string[];
  localStream: MediaStream | null;
  peerStreams: PeerStreams;
  selectedStream: string | null;
  selectStream: (streamOwnerId: string) => void;
  shareScreen: () => Promise<MediaStream | null>;
  stopSharing: () => void;
  userId: string;
}

export function useWebRTC(props: UseWebRTCProps): UseWebRTCResult; 