import { useCallback, useEffect, useRef, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import {
  PeerConnections,
  PeerStreamData,
  StreamSenders,
  UseWebRTCProps,
  UseWebRTCResult,
} from './types/webRTC';
import { useMediaStreams } from './useMediaStreams';
import { useOfferAnswer } from './useOfferAnswer';
import { usePeerConnections } from './usePeerConnections';
import { useSignallingServer } from './useSignallingServer';

export function useWebRTCFirebase({ roomId }: UseWebRTCProps): UseWebRTCResult {
  // State for connection status
  const [isConnected, setIsConnected] = useState<boolean>(false);
  const [isConnecting, setIsConnecting] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  // State for peers
  const [peers, setPeers] = useState<string[]>([]);
  const [peerStreams, setPeerStreams] = useState<Record<string, MediaStream>>({});
  const [peerStreamsWithData, setPeerStreamsWithData] = useState<Record<string, PeerStreamData>>(
    {}
  );
  const [selectedStream, setSelectedStream] = useState<string | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);

  // References
  const peerConnections = useRef<PeerConnections>({});
  const localStreamRef = useRef<MediaStream | null>(null);
  const userId = useRef<string>(uuidv4());
  const isUnmounting = useRef<boolean>(false);
  const streamSenders = useRef<StreamSenders>({});
  const userUnsubscribeFunction = useRef<(() => void) | null>(null);
  const offersUnsubscribeFunction = useRef<(() => void) | null>(null);
  const answersUnsubscribeFunction = useRef<(() => void) | null>(null);
  const peersUnsubscribeFunction = useRef<(() => void) | null>(null);
  const candidatesUnsubscribeFunction = useRef<(() => void) | null>(null);
  const processedOfferIds = useRef<Set<string>>(new Set());
  const processingOffer = useRef<boolean>(false);
  const currentRoomId = useRef<string | null>(null);
  const connectionEstablished = useRef<boolean>(false);
  const hasInitializedConnection = useRef<boolean>(false);
  const processedAnswerIds = useRef<Set<string>>(new Set());

  const { createPeerConnection, resetAndRecreateConnection, handleIceCandidate, handlePeerLeft } =
    usePeerConnections({
      roomId,
      userId,
      peerConnections,
      localStreamRef,
      streamSenders,
      setPeerStreams,
      peers,
      setPeers,
      setPeerStreamsWithData,
      selectedStream,
      setSelectedStream,
      setError,
    });

  const { handleOffer, handleAnswer } = useOfferAnswer({
    roomId,
    userId,
    processedOfferIds,
    processingOffer,
    localStreamRef,
    peerConnections,
    createPeerConnection,
    setError,
    setPeerStreamsWithData,
    resetAndRecreateConnection,
    streamSenders,
    selectedStream,
    peerStreamsWithData,
    selectStream: setSelectedStream,
    peerStreams,
    processedAnswerIds,
  });

  const { requestStream, connectToRoom, disconnectFromRoom } = useSignallingServer({
    roomId,
    userId,
    setPeers,
    peerConnections,
    createPeerConnection,
    handlePeerLeft,
    userUnsubscribeFunction,
    setPeerStreamsWithData,
    setSelectedStream,
    peerStreams,
    peerStreamsWithData,
    peersUnsubscribeFunction,
    handleOffer,
    offersUnsubscribeFunction,
    handleAnswer,
    answersUnsubscribeFunction,
    handleIceCandidate,
    candidatesUnsubscribeFunction,
    setError,
    setIsConnected,
    setIsConnecting,
    setIsLoading,
    streamSenders,
    resetState,
    isUnmounting,
  });

  const { stopSharing, shareScreen, selectStream } = useMediaStreams({
    roomId,
    userId,
    peerStreamsWithData,
    peerConnections,
    localStreamRef,
    setLocalStream,
    setSelectedStream,
    setPeerStreamsWithData,
    createPeerConnection,
    streamSenders,
    setError,
  });

  // Reset WebRTC state
  const resetState = useCallback(() => {
    // Reset various state variables
    processedOfferIds.current.clear();
    processedAnswerIds.current.clear();
    connectionEstablished.current = false;

    console.log('[WebRTC] Resetting initialization for future reconnection');
    hasInitializedConnection.current = false;
  }, []);

  // Main connection effect
  useEffect(() => {
    // Skip if no roomId
    if (!roomId) {
      console.log('[WebRTC] No room ID, skipping connection');
      return;
    }

    // Set unmounting flag to false on mount/reconnect
    isUnmounting.current = false;

    // Prevent double initialization
    if (hasInitializedConnection.current && currentRoomId.current === roomId) {
      console.log(`[WebRTC] Already initialized for room ${roomId}, skipping`);
      return;
    }

    console.log(`[WebRTC] Initializing for room: ${roomId}`);
    hasInitializedConnection.current = true;
    currentRoomId.current = roomId;

    // Setup connection
    connectToRoom();

    // Mark the connection as established
    connectionEstablished.current = true;

    // Cleanup
    return () => {
      console.log(`[WebRTC] Cleaning up room: ${roomId}`);
      disconnectFromRoom();
    };
  }, [roomId, connectToRoom, disconnectFromRoom]);

  return {
    isConnected,
    isConnecting,
    isLoading,
    error,
    clearError: () => setError(null),
    peers,
    localStream, // Use the state variable instead of the ref
    peerStreams,
    peerStreamsWithData,
    selectedStream,
    selectStream,
    shareScreen,
    stopSharing,
    userId: userId.current,
    requestStream,
  };
}
