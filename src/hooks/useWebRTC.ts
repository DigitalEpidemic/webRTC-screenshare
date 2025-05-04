import { useState, useEffect, useRef, useCallback } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { io, Socket } from 'socket.io-client';

interface UseWebRTCProps {
  roomId: string;
}

interface PeerStreams {
  [peerId: string]: MediaStream | null;
}

interface StreamSenders {
  [peerId: string]: RTCRtpSender[];
}

interface PendingCandidates {
  [peerId: string]: RTCIceCandidateInit[];
}

interface StreamingMetadata {
  [peerId: string]: {
    streamAttempts: number;
    pingAttempt: number;
    failedCandidates?: RTCIceCandidateInit[];
    isRecreating?: boolean;
    pendingOffer?: RTCSessionDescriptionInit;
    iceFailures?: number;
    streamRef?: MediaStream;
  };
}

interface PeerConnections {
  [peerId: string]: RTCPeerConnection;
}

interface SignalingMessage {
  type?: string;
  from: string;
  target?: string;
  offer?: RTCSessionDescriptionInit;
  answer?: RTCSessionDescriptionInit;
  ice?: RTCIceCandidateInit;
  needsStream?: boolean;
  hasScreen?: boolean;
}

interface RoomInfo {
  participants: string[];
  roomId: string;
  streamingUsers?: string[];
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

export function useWebRTC({ roomId }: UseWebRTCProps): UseWebRTCResult {
  const [isConnected, setIsConnected] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [peers, setPeers] = useState<string[]>([]);
  const [peerStreams, setPeerStreams] = useState<PeerStreams>({});
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [selectedStream, setSelectedStream] = useState<string | null>(null);
  
  const socket = useRef<Socket | null>(null);
  const peerConnections = useRef<PeerConnections>({});
  const localStreamRef = useRef<MediaStream | null>(null);
  const userId = useRef<string>(uuidv4());
  const isUnmounting = useRef<boolean>(false);
  const pendingCandidates = useRef<PendingCandidates>({});
  const streamSenders = useRef<StreamSenders>({});
  const streamMetadata = useRef<StreamingMetadata>({});

  // Connect to the signaling server
  const connectToSignalingServer = useCallback(() => {
    if (isUnmounting.current) return;
    
    setIsLoading(true);
    setError(null);
    
    try {
      // Use the proxied Socket.IO endpoint
      // In development, Vite proxy will forward to the actual server
      const socketUrl = '/';
      
      console.log('Connecting to Socket.IO server');
      
      // Close existing connection if any
      if (socket.current) {
        socket.current.disconnect();
      }
      
      // Create new Socket.IO connection with auto-reconnection
      socket.current = io(socketUrl, {
        reconnectionAttempts: 5,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        timeout: 20000,
        transports: ['websocket', 'polling'],
        path: '/socket.io'
      });
      
      // Handle connection events
      socket.current.on('connect', () => {
        console.log('Connected to signaling server', socket.current?.id);
        
        // Join the room
        socket.current?.emit('join', {
          room: roomId,
          userId: userId.current
        });
      });
      
      socket.current.on('connect_error', (err: Error) => {
        console.error('Connection error:', err);
        setError('Failed to connect to the signaling server: ' + err.message);
        setIsLoading(false);
      });
      
      socket.current.on('disconnect', (reason: string) => {
        console.log('Disconnected from signaling server:', reason);
        setIsConnected(false);
        
        if (reason === 'io server disconnect') {
          // The server has forcefully disconnected
          socket.current?.connect();
        }
      });
      
      // Handle room information updates
      socket.current.on('room-info', handleRoomInfo);
      
      // Handle WebRTC signaling
      socket.current.on('signal', handleSignalingMessage);

      // Handle user disconnect
      socket.current.on('user-left', (data: { userId: string }) => {
        const { userId: leavingUserId } = data;
        console.log('User left:', leavingUserId);
        
        // Remove peer connections
        if (peerConnections.current[leavingUserId]) {
          peerConnections.current[leavingUserId].close();
          delete peerConnections.current[leavingUserId];
        }
        
        // Remove streams and senders
        setPeerStreams(prev => {
          const newStreams = {...prev};
          delete newStreams[leavingUserId];
          return newStreams;
        });
        
        if (streamSenders.current[leavingUserId]) {
          delete streamSenders.current[leavingUserId];
        }
        
        // Update peers list
        setPeers(prev => prev.filter(id => id !== leavingUserId));
        
        // If selected stream is from the user who left, reset selection
        setSelectedStream(prev => {
          if (prev === leavingUserId) return null;
          return prev;
        });
      });
      
      // Handle stream updates
      socket.current.on('stream-update', (data: { userId: string, isStreaming: boolean }) => {
        const { userId: streamingUserId, isStreaming } = data;
        console.log(`Received stream update: ${streamingUserId} ${isStreaming ? 'started' : 'stopped'} streaming`);
        
        if (isStreaming) {
          // When a peer starts streaming, we should mark them as sharing even if we haven't received their tracks yet
          // This will update the UI to show they're sharing
          console.log(`Marking peer ${streamingUserId} as sharing`);
          
          // Mark the peer as sharing in the UI with a placeholder (null) stream if we don't already have a stream
          if (!peerStreams[streamingUserId]) {
            storeStream(streamingUserId, null);
          }
          
          // Initialize metadata for this peer if needed
          if (!streamMetadata.current[streamingUserId]) {
            streamMetadata.current[streamingUserId] = {
              streamAttempts: 0,
              pingAttempt: 0,
              iceFailures: 0
            };
          }
          
          // Check if we've already made too many recreation attempts
          const attempts = streamMetadata.current[streamingUserId].streamAttempts;
          
          // Limit to 2 recreation attempts per peer to avoid excessive reconnections
          if (attempts < 2) {
            streamMetadata.current[streamingUserId].streamAttempts++;
            
            // Aggressively recreate the connection to ensure we get the stream
            if (peerConnections.current[streamingUserId]) {
              console.log(`Recreating connection with ${streamingUserId} to receive their stream (attempt ${attempts + 1})`);
              
              // Close and clean up the existing connection
              const oldPC = peerConnections.current[streamingUserId];
              oldPC.close();
              delete peerConnections.current[streamingUserId];
              
              // Clear any stored senders
              if (streamSenders.current[streamingUserId]) {
                streamSenders.current[streamingUserId] = [];
              }
              
              // Clear pending candidates
              if (pendingCandidates.current[streamingUserId]) {
                pendingCandidates.current[streamingUserId] = [];
              }
              
              // Create a new connection after a brief delay to allow cleanup
              // Use increasing delays for successive attempts to avoid overloading network
              const delay = 500 + (attempts * 500); 
              
              setTimeout(() => {
                // Check if we already have a stream before recreating
                if (peerStreams[streamingUserId] !== null && streamingUserId in peerStreams) {
                  console.log(`Already have stream from ${streamingUserId}, skipping recreation`);
                  return;
                }
                
                console.log(`Creating new connection to receive stream from ${streamingUserId}`);
                
                // Use a more compatible configuration that works across browsers
                const pc = new RTCPeerConnection({
                  iceServers: [
                    { urls: 'stun:stun.l.google.com:19302' },
                    { urls: 'stun:stun1.l.google.com:19302' },
                    { 
                      urls: 'turn:numb.viagenie.ca',
                      username: 'webrtc@live.com',
                      credential: 'muazkh'
                    }
                  ],
                  iceCandidatePoolSize: 10
                });
                
                // Store the connection
                peerConnections.current[streamingUserId] = pc;
                pendingCandidates.current[streamingUserId] = [];
                
                // Set up basic handlers
                pc.onicecandidate = (event) => {
                  if (event.candidate && socket.current && socket.current.connected) {
                    socket.current.emit('signal', {
                      type: 'ice',
                      ice: event.candidate,
                      target: streamingUserId,
                      from: userId.current
                    });
                  }
                };
                
                pc.oniceconnectionstatechange = () => {
                  console.log(`ICE connection state with ${streamingUserId}: ${pc.iceConnectionState}`);
                  
                  // Add more robust recovery for failed connections
                  if (pc.iceConnectionState === 'failed') {
                    console.log(`ICE connection failed with ${streamingUserId}, attempting recovery`);
                    try {
                      pc.restartIce();
                    } catch (err) {
                      console.warn('Could not restart ICE:', err);
                    }
                  }
                };
                
                // Important: handle receiving tracks
                pc.ontrack = (event) => {
                  console.log(`Received ${event.track.kind} track from ${streamingUserId}`);
                  
                  if (event.streams && event.streams.length > 0) {
                    const stream = event.streams[0];
                    const tracks = stream.getTracks();
                    console.log(`Stream has ${tracks.length} tracks:`, tracks.map(t => t.kind).join(', '));
                    
                    if (stream.getVideoTracks().length > 0) {
                      console.log(`Received stream from ${streamingUserId} with video, storing it`);
                      
                      // Store the stream for this peer
                      storeStream(streamingUserId, stream);
                      
                      // Reset the renegotiation attempt count when we get a valid stream
                      if (streamMetadata.current[streamingUserId]) {
                        streamMetadata.current[streamingUserId].streamAttempts = 0;
                      }
                      
                      // Auto-select this stream if nothing is selected
                      if (!selectedStream) {
                        setSelectedStream(streamingUserId);
                      }
                    } else {
                      console.warn(`Stream from ${streamingUserId} has no video tracks, may not be visible`);
                      storeStream(streamingUserId, stream);
                    }
                  }
                };
                
                // Add our tracks if we have any
                if (localStreamRef.current) {
                  localStreamRef.current.getTracks().forEach(track => {
                    console.log(`Adding our ${track.kind} track to new connection with ${streamingUserId}`);
                    const sender = pc.addTrack(track, localStreamRef.current!);
                    
                    // Store the sender for later cleanup
                    if (!streamSenders.current[streamingUserId]) {
                      streamSenders.current[streamingUserId] = [];
                    }
                    streamSenders.current[streamingUserId].push(sender);
                  });
                }
                
                // Send a ping to initiate negotiation, with a slight delay to ensure setup is complete
                setTimeout(() => {
                  if (socket.current && socket.current.connected && 
                      // Only send if we still don't have the stream
                      (peerStreams[streamingUserId] === null || !(streamingUserId in peerStreams))) {
                    console.log(`Sending ping to ${streamingUserId} to get their stream`);
                    socket.current.emit('signal', {
                      type: 'ping',
                      target: streamingUserId,
                      from: userId.current,
                      needsStream: true
                    });
                  }
                }, 300);
              }, delay);
            }
          } else {
            console.log(`Already attempted ${attempts} recreations for ${streamingUserId}, waiting for ping mechanism`);
          }
        } else {
          // If a peer stopped streaming, remove their stream from our state
          setPeerStreams(prev => {
            const newStreams = {...prev};
            delete newStreams[streamingUserId];
            return newStreams;
          });
          
          // Reset the attempt counter when peer stops streaming
          if (streamMetadata.current[streamingUserId]) {
            streamMetadata.current[streamingUserId].streamAttempts = 0;
          }
          
          // Reset selected stream if needed
          setSelectedStream(prev => {
            if (prev === streamingUserId) return null;
            return prev;
          });
        }
      });
      
    } catch (error) {
      console.error('Error creating Socket.IO connection:', error);
      setError('Failed to create connection: ' + (error instanceof Error ? error.message : String(error)));
      setIsLoading(false);
    }
  }, [roomId]);

  // Handle room information
  const handleRoomInfo = useCallback((roomInfo: RoomInfo) => {
    console.log('Room info:', roomInfo);
    const filteredPeers = roomInfo.participants.filter(id => id !== userId.current);
    setPeers(filteredPeers);

    // Create peer connections for new peers
    for (const peerId of filteredPeers) {
      if (!peerConnections.current[peerId]) {
        // We'll initiate connections from the "newer" user
        // so the connection directions are consistent
        const shouldInitiate = userId.current > peerId;
        console.log(`Creating connection with ${peerId}, initiating: ${shouldInitiate}`);
        createPeerConnection(peerId, shouldInitiate);
      }
    }
    
    // Mark peers that are currently streaming
    if (roomInfo.streamingUsers && roomInfo.streamingUsers.length > 0) {
      console.log('Users currently streaming:', roomInfo.streamingUsers);
      
      roomInfo.streamingUsers.forEach(streamingId => {
        // Only process peers (not ourselves)
        if (streamingId !== userId.current) {
          console.log(`Marking peer ${streamingId} as streaming from room info`);
          
          // Mark the peer as streaming with a placeholder until we receive actual stream
          setPeerStreams(prev => {
            // Don't update if we already have this stream
            if (prev[streamingId]) return prev;
            
            return {
              ...prev,
              [streamingId]: null
            };
          });
          
          // Initialize metadata for this peer if needed
          if (!streamMetadata.current[streamingId]) {
            streamMetadata.current[streamingId] = {
              streamAttempts: 0,
              pingAttempt: 0,
              iceFailures: 0
            };
          }
        }
      });
    }
    
    setIsLoading(false);
    setIsConnected(true);
  }, []);

  // Handle messages from the signaling server
  const handleSignalingMessage = useCallback((message: SignalingMessage) => {
    console.log('Received signal:', message.type || 'ice candidate', 'from', message.from);
    
    if (message.type === 'ping' && message.needsStream) {
      // A peer is requesting our stream - send them an offer
      const peerId = message.from;
      console.log(`Received stream request ping from ${peerId}`);
      
      const pc = peerConnections.current[peerId];
      if (pc && localStreamRef.current) {
        console.log(`Sending offer with our stream to ${peerId}`);
        
        // First make sure we have a clean connection
        // Remove any existing tracks
        if (streamSenders.current[peerId]) {
          streamSenders.current[peerId].forEach(sender => {
            try {
              pc.removeTrack(sender);
            } catch (err) {
              console.warn(`Could not remove track from connection with ${peerId}:`, err);
            }
          });
          streamSenders.current[peerId] = [];
        }
        
        // Add our current tracks
        if (localStreamRef.current) {
          // Add tracks directly
          console.log(`Adding tracks to connection with ${peerId}`);
          
          // Keep track of senders for this connection
          if (!streamSenders.current[peerId]) {
            streamSenders.current[peerId] = [];
          }
          
          // Add all tracks from our stream
          localStreamRef.current.getTracks().forEach(track => {
            console.log(`Adding ${track.kind} track to connection with ${peerId}`);
            const sender = pc.addTrack(track, localStreamRef.current!);
            streamSenders.current[peerId].push(sender);
          });
        }
        
        // Send a new offer with our stream
        pc.createOffer()
          .then(offer => pc.setLocalDescription(offer))
          .then(() => {
            if (socket.current && socket.current.connected) {
              socket.current.emit('signal', {
                type: 'offer',
                offer: pc.localDescription,
                target: peerId,
                from: userId.current,
                hasScreen: true // Explicitly indicate this offer has screen share
              });
            }
          })
          .catch(error => {
            console.error('Error creating offer after ping:', error);
          });
      } else {
        console.log(`Cannot respond to stream request from ${peerId} - no local stream or peer connection`);
      }
    } 
    else if (message.offer) {
      handleOffer(message);
    } 
    else if (message.answer) {
      handleAnswer(message);
    } 
    else if (message.ice) {
      handleIceCandidate(message);
    }
  }, []);

  // Add tracks to a peer connection
  const addTracksToConnection = useCallback((pc: RTCPeerConnection, peerId: string) => {
    if (!localStreamRef.current) return;
    
    console.log(`Adding tracks to connection with ${peerId}`);
    
    // Keep track of senders for this connection
    if (!streamSenders.current[peerId]) {
      streamSenders.current[peerId] = [];
    }
    
    // Add all tracks
    localStreamRef.current.getTracks().forEach(track => {
      console.log(`Adding ${track.kind} track to connection with ${peerId}`);
      const sender = pc.addTrack(track, localStreamRef.current!);
      streamSenders.current[peerId].push(sender);
    });
  }, []);
  
  // Remove tracks from a peer connection
  const removeTracksFromConnection = useCallback((peerId: string) => {
    const pc = peerConnections.current[peerId];
    if (!pc) return;
    
    if (streamSenders.current[peerId]) {
      console.log(`Removing tracks from connection with ${peerId}`);
      streamSenders.current[peerId].forEach(sender => {
        try {
          pc.removeTrack(sender);
        } catch (err) {
          console.warn(`Could not remove track from connection with ${peerId}:`, err);
        }
      });
      streamSenders.current[peerId] = [];
    }
  }, []);

  // Share screen
  const shareScreen = useCallback(async (): Promise<MediaStream | null> => {
    try {
      console.log('Requesting screen share');
      const stream = await navigator.mediaDevices.getDisplayMedia({ 
        video: true,
        audio: false // Audio often causes issues, set to true if needed
      });
      
      console.log('Screen share access granted', stream.getTracks().map(t => t.kind));
      
      localStreamRef.current = stream;
      setLocalStream(stream);
      
      // Handle stream end (user stops sharing)
      stream.getVideoTracks()[0].onended = () => {
        console.log('User stopped screen share via browser UI');
        stopSharing();
      };
      
      // Clear existing peer connections to force fresh negotiation
      const oldConnections = { ...peerConnections.current };
      
      // Notify peers about stream before adding tracks to give them time to prepare
      if (socket.current && socket.current.connected) {
        console.log('Notifying server about started stream');
        socket.current.emit('stream-started', {
          userId: userId.current,
          roomId
        });
      }
      
      // Wait a moment for stream-update to be processed by peers
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Recreate connections for more reliable track adding
      for (const peerId in oldConnections) {
        console.log(`Recreating connection with ${peerId} to share screen`);
        
        // Close existing connection
        if (peerConnections.current[peerId]) {
          peerConnections.current[peerId].close();
          delete peerConnections.current[peerId];
        }
        
        // Clear any stored senders
        if (streamSenders.current[peerId]) {
          streamSenders.current[peerId] = [];
        }
        
        // Create a new connection with our stream ready to go
        const pc = new RTCPeerConnection({
          iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { 
              urls: 'turn:numb.viagenie.ca',
              username: 'webrtc@live.com',
              credential: 'muazkh'
            }
          ],
          iceCandidatePoolSize: 10
        });
        
        // Initialize connection setup
        peerConnections.current[peerId] = pc;
        pendingCandidates.current[peerId] = [];
        
        // Add our screen share tracks
        if (!streamSenders.current[peerId]) {
          streamSenders.current[peerId] = [];
        }
        
        // Add all tracks
        stream.getTracks().forEach(track => {
          console.log(`Adding ${track.kind} track to new connection with ${peerId}`);
          const sender = pc.addTrack(track, stream);
          streamSenders.current[peerId].push(sender);
        });
        
        // Basic event handlers
        pc.onicecandidate = (event) => {
          if (event.candidate && socket.current && socket.current.connected) {
            socket.current.emit('signal', {
              type: 'ice',
              ice: event.candidate,
              target: peerId,
              from: userId.current
            });
          }
        };
        
        pc.oniceconnectionstatechange = () => {
          console.log(`ICE connection state with ${peerId}: ${pc.iceConnectionState}`);
        };
        
        pc.ontrack = (event) => {
          console.log('Received track from peer:', peerId, event.track.kind);
          
          if (event.streams && event.streams.length > 0) {
            const remoteStream = event.streams[0];
            setPeerStreams(prev => ({
              ...prev,
              [peerId]: remoteStream
            }));
          }
        };
        
        // Make sure we are the initiator for this new connection
        console.log(`Creating offer for ${peerId} with screen share tracks`);
        
        pc.createOffer()
          .then(offer => {
            console.log(`Setting local description for ${peerId}`);
            return pc.setLocalDescription(offer);
          })
          .then(() => {
            if (socket.current && socket.current.connected) {
              console.log(`Sending offer to ${peerId} with screen share tracks`);
              socket.current.emit('signal', {
                type: 'offer',
                offer: pc.localDescription,
                target: peerId,
                from: userId.current,
                hasScreen: true // Let peer know this offer includes screen share
              });
            }
          })
          .catch(error => {
            console.error(`Error creating offer for ${peerId}:`, error);
          });
      }
      
      return stream;
    } catch (error) {
      console.error('Error sharing screen:', error);
      setError('Failed to share screen: ' + (error instanceof Error ? error.message : String(error)));
      return null;
    }
  }, [roomId]);

  // Stop sharing
  const stopSharing = useCallback(() => {
    if (localStreamRef.current) {
      console.log('Stopping screen share');
      
      // Stop all tracks
      localStreamRef.current.getTracks().forEach(track => {
        track.stop();
      });
      
      localStreamRef.current = null;
      setLocalStream(null);
      
      // Notify peers about stopped stream
      if (socket.current && socket.current.connected) {
        console.log('Notifying server about stopped stream');
        socket.current.emit('stream-stopped', {
          userId: userId.current,
          roomId
        });
      }
      
      // Remove tracks from all peer connections
      for (const peerId in peerConnections.current) {
        removeTracksFromConnection(peerId);
      }
      
      // Reset selected stream if it was ours
      setSelectedStream(prev => {
        if (prev === userId.current) return null;
        return prev;
      });
    }
  }, [roomId, removeTracksFromConnection]);

  // Create a new peer connection
  const createPeerConnection = useCallback((peerId: string, isInitiator: boolean): RTCPeerConnection | null => {
    try {
      // Close existing connection if any
      if (peerConnections.current[peerId]) {
        peerConnections.current[peerId].close();
        
        // Clean up senders
        if (streamSenders.current[peerId]) {
          streamSenders.current[peerId] = [];
        }
        
        delete peerConnections.current[peerId];
      }
      
      console.log(`Creating new RTCPeerConnection with ${peerId}`);
      
      // Use a more compatible configuration that works across browsers
      const pc = new RTCPeerConnection({
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
          { 
            urls: 'turn:numb.viagenie.ca',
            username: 'webrtc@live.com',
            credential: 'muazkh'
          }
        ],
        iceCandidatePoolSize: 10
      });
      
      // Initialize pending candidates array
      pendingCandidates.current[peerId] = [];
      
      // Initialize metadata for this peer if needed
      if (!streamMetadata.current[peerId]) {
        streamMetadata.current[peerId] = {
          streamAttempts: 0,
          pingAttempt: 0,
          iceFailures: 0
        };
      } else {
        // Reset some counters when creating a new connection
        streamMetadata.current[peerId].iceFailures = 0;
      }
      
      // Flag to track if we're in the middle of the initial connection establishment
      // This helps prevent triggering renegotiation during the setup phase
      let isInitialSetup = true;
      
      // Add local stream tracks if we're already sharing
      if (localStreamRef.current) {
        addTracksToConnection(pc, peerId);
      }
      
      // Handle ICE candidates
      pc.onicecandidate = (event) => {
        if (event.candidate && socket.current && socket.current.connected) {
          socket.current.emit('signal', {
            type: 'ice',
            ice: event.candidate,
            target: peerId,
            from: userId.current
          });
        }
      };
      
      // Track ICE gathering state for better debugging
      pc.onicegatheringstatechange = () => {
        console.log(`ICE gathering state with ${peerId}: ${pc.iceGatheringState}`);
        
        // When gathering is complete, log connection properties for debugging
        if (pc.iceGatheringState === 'complete') {
          console.log(`ICE gathering complete for ${peerId}`);
          // Log information about available candidates
          const senders = pc.getSenders();
          console.log(`Connection has ${senders.length} senders`);
        }
      };
      
      // Log ICE connection state changes
      pc.oniceconnectionstatechange = () => {
        console.log(`ICE connection state with ${peerId}: ${pc.iceConnectionState}`);
        
        // If ICE connection failed, try reconnecting with progressive backoff
        if (pc.iceConnectionState === 'failed') {
          if (streamMetadata.current[peerId]) {
            // Initialize iceFailures if it doesn't exist yet
            if (typeof streamMetadata.current[peerId].iceFailures !== 'number') {
              streamMetadata.current[peerId].iceFailures = 0;
            }
            
            // Increment failure count
            streamMetadata.current[peerId].iceFailures! += 1;
            const failures = streamMetadata.current[peerId].iceFailures || 1;
            
            console.log(`ICE connection with ${peerId} failed (attempt ${failures}), attempting to restart`);
            
            // Use exponential backoff for repeated failures
            const delay = Math.min(1000 * Math.pow(2, failures - 1), 8000);
            
            setTimeout(() => {
              if (peerConnections.current[peerId] === pc) {
                try {
                  console.log(`Restarting ICE for ${peerId}`);
                  pc.restartIce();
                  
                  // After too many failures, recreate the whole connection
                  if (failures >= 3) {
                    console.log(`Too many ICE failures with ${peerId}, recreating connection`);
                    createPeerConnection(peerId, isInitiator);
                  }
                } catch (e) {
                  console.warn('Error during ICE restart:', e);
                }
              }
            }, delay);
          }
        }
        
        // If the connection is completed but we have a placeholder for this peer's stream
        // but no actual stream, try pinging them for their stream
        if ((pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed')) {
          const peerHasPlaceholderButNoStream = peerId in peerStreams && peerStreams[peerId] === null;
          
          if (peerHasPlaceholderButNoStream && socket.current && socket.current.connected) {
            console.log(`Connection with ${peerId} established but no stream received. Sending stream request ping.`);
            
            socket.current.emit('signal', {
              type: 'ping',
              target: peerId,
              from: userId.current,
              needsStream: true
            });
          }
        }
      };
      
      // Handle connection state changes
      pc.onconnectionstatechange = () => {
        console.log(`Connection state with ${peerId}: ${pc.connectionState}`);
        
        if (pc.connectionState === 'connected') {
          console.log(`Connected to peer ${peerId}`);
          
          // Connection is established, we can allow renegotiation
          isInitialSetup = false;
          
          // If we're sharing a screen, make sure the peer has our tracks
          if (localStreamRef.current && !streamSenders.current[peerId]?.length) {
            console.log(`Adding tracks to new connection with ${peerId}`);
            addTracksToConnection(pc, peerId);
            
            // Renegotiate
            pc.createOffer()
              .then(offer => pc.setLocalDescription(offer))
              .then(() => {
                if (socket.current && socket.current.connected) {
                  socket.current.emit('signal', {
                    type: 'offer',
                    offer: pc.localDescription,
                    target: peerId,
                    from: userId.current
                  });
                }
              })
              .catch(error => {
                console.error('Error creating offer after adding tracks:', error);
              });
          }
        } 
        else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
          console.log(`Disconnected from peer ${peerId}`);
          
          if (streamSenders.current[peerId]) {
            streamSenders.current[peerId] = [];
          }
          
          if (pc.connectionState === 'failed') {
            // If the connection failed completely, recreate it
            console.log(`Connection with ${peerId} failed, recreating`);
            
            setTimeout(() => {
              if (peerConnections.current[peerId] === pc) {
                createPeerConnection(peerId, true);
              }
            }, 2000);
          }
        }
      };
      
      // Handle negotiation needed events
      pc.onnegotiationneeded = async () => {
        // Skip renegotiation if we're still in the initial setup
        if (isInitialSetup) {
          console.log('Ignoring negotiation needed during initial setup');
          return;
        }
        
        console.log(`Negotiation needed for connection with ${peerId}`);
        
        try {
          // Only the initiator should create offers during negotiation
          // unless this is triggered by adding tracks after connection
          if (isInitiator || localStreamRef.current) {
            console.log('Creating offer due to negotiation needed');
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            
            if (socket.current && socket.current.connected) {
              console.log('Sending offer after negotiation needed');
              socket.current.emit('signal', {
                type: 'offer',
                offer: pc.localDescription,
                target: peerId,
                from: userId.current
              });
            }
          }
        } catch (error) {
          console.error('Error during negotiation:', error);
        }
      };
      
      // Handle incoming tracks from peers
      pc.ontrack = (event) => {
        console.log('Received track from peer:', peerId, event.track.kind);
        
        // Store the incoming stream associated with this peer
        if (event.streams && event.streams.length > 0) {
          console.log(`Received ${event.streams.length} streams from ${peerId}`);
          const stream = event.streams[0];
          
          // Log each track in the stream for debugging
          const tracks = stream.getTracks();
          console.log(`Stream has ${tracks.length} tracks:`, tracks.map(t => t.kind).join(', '));
          
          // Only store the stream if it has video tracks
          if (stream.getVideoTracks().length > 0) {
            console.log(`Stream from ${peerId} has video, storing it`);
            
            setPeerStreams(prev => ({
              ...prev,
              [peerId]: stream
            }));
            
            // If this is the first incoming stream, select it by default
            if (!selectedStream) {
              setSelectedStream(peerId);
            }
          } else {
            console.log(`Stream from ${peerId} has no video tracks, not storing`);
          }
        } else {
          console.warn('Received track event with no streams');
        }
      };
      
      // Create and send offer if initiator
      if (isInitiator) {
        console.log(`Creating offer as initiator for ${peerId}`);
        pc.createOffer()
          .then(offer => {
            console.log('Created offer, setting local description');
            return pc.setLocalDescription(offer);
          })
          .then(() => {
            console.log('Local description set, sending offer');
            if (socket.current && socket.current.connected) {
              socket.current.emit('signal', {
                type: 'offer',
                offer: pc.localDescription,
                target: peerId,
                from: userId.current
              });
            }
          })
          .catch(error => {
            console.error('Error creating offer:', error);
            setError('Failed to create connection offer');
          });
      }
      
      peerConnections.current[peerId] = pc;
      return pc;
    } catch (error) {
      console.error('Error creating peer connection:', error);
      setError('Failed to create peer connection: ' + (error instanceof Error ? error.message : String(error)));
      return null;
    }
  }, [addTracksToConnection]);

  // Handle incoming offer
  const handleOffer = useCallback((message: SignalingMessage) => {
    const peerId = message.from;
    const hasScreen = message.hasScreen;
    const needsStream = message.needsStream;
    
    // Log helpful debugging information
    console.log(
      `Received offer from ${peerId}${hasScreen ? ' with screen share' : ''}${needsStream ? ' (needs our stream)' : ''}, creating answer`
    );
    
    // If we already have this peer's connection in a non-stable state, and this isn't a screen share,
    // queue the offer for later to avoid collisions
    if (peerConnections.current[peerId] && 
        peerConnections.current[peerId].signalingState !== 'stable' && 
        !hasScreen && !needsStream) {
      console.log(`Connection with ${peerId} not in stable state, queueing offer for later`);
      
      // Store this offer to process after the current negotiation completes
      if (!streamMetadata.current[peerId]) {
        streamMetadata.current[peerId] = { streamAttempts: 0, pingAttempt: 0 };
      }
      
      // Store the offer to process later
      streamMetadata.current[peerId].pendingOffer = message.offer;
      
      // Set a timeout to handle the offer if the connection doesn't stabilize
      setTimeout(() => {
        if (streamMetadata.current[peerId]?.pendingOffer && 
            peerConnections.current[peerId]) {
          
          // Check if we're now in a stable state
          if (peerConnections.current[peerId].signalingState === 'stable') {
            console.log(`Processing queued offer for ${peerId}`);
            const queuedOffer = streamMetadata.current[peerId].pendingOffer;
            delete streamMetadata.current[peerId].pendingOffer;
            
            // Process the queued offer
            if (queuedOffer) {
              peerConnections.current[peerId].setRemoteDescription(new RTCSessionDescription(queuedOffer))
                .then(() => peerConnections.current[peerId].createAnswer())
                .then(answer => peerConnections.current[peerId].setLocalDescription(answer))
                .then(() => {
                  if (socket.current && socket.current.connected) {
                    socket.current.emit('signal', {
                      type: 'answer',
                      answer: peerConnections.current[peerId].localDescription,
                      target: peerId,
                      from: userId.current
                    });
                  }
                })
                .catch(err => console.error('Error processing queued offer:', err));
            }
          } else {
            console.log(`Connection with ${peerId} still not stable, discarding queued offer`);
            delete streamMetadata.current[peerId].pendingOffer;
          }
        }
      }, 2000);
      
      return;
    }
    
    // Create a peer connection if it doesn't exist
    let pc = peerConnections.current[peerId];
    if (!pc) {
      const newPc = createPeerConnection(peerId, false);
      if (!newPc) {
        console.error('Failed to create peer connection');
        return;
      }
      pc = newPc;
    }
    
    if (message.offer) {
      // Check if there's already a pending operation that might conflict
      const signalingState = pc.signalingState;
      
      // If we're not in "stable" state, we might need to roll back
      if (signalingState !== 'stable') {
        console.log(`PeerConnection not in stable state (${signalingState}), rolling back`);
        
        // Rollback by creating an empty description to reset state
        try {
          // This is a workaround to reset the connection state
          const emptyDesc = { type: 'rollback' } as RTCSessionDescription;
          pc.setLocalDescription(emptyDesc)
            .catch(err => console.warn('Rollback failed:', err));
        } catch (e) {
          console.warn('Rollback not supported, trying to proceed anyway');
        }
      }

      // Set the remote description
      pc.setRemoteDescription(new RTCSessionDescription(message.offer))
        .then(() => {
          console.log('Remote description set, creating answer');
          
          // If the peer has screen sharing, mark them as sharing in our UI
          if (hasScreen) {
            console.log(`Marking ${peerId} as screen sharing from offer`);
            setPeerStreams(prev => ({
              ...prev,
              [peerId]: prev[peerId] || null
            }));
          }
          
          return pc.createAnswer();
        })
        .then(answer => {
          console.log('Answer created, setting local description');
          return pc.setLocalDescription(answer);
        })
        .then(() => {
          // Send the answer back
          console.log('Local description set, sending answer');
          
          if (socket.current && socket.current.connected) {
            socket.current.emit('signal', {
              type: 'answer',
              answer: pc.localDescription,
              target: peerId,
              from: userId.current
            });
          }
          
          // Apply any pending ICE candidates
          if (pendingCandidates.current[peerId]) {
            console.log(`Applying ${pendingCandidates.current[peerId].length} pending ICE candidates`);
            pendingCandidates.current[peerId].forEach(candidate => {
              pc.addIceCandidate(new RTCIceCandidate(candidate))
                .catch(err => console.error('Error adding pending ICE candidate:', err));
            });
            pendingCandidates.current[peerId] = [];
          }
        })
        .catch(error => {
          console.error('Error handling offer:', error);
          
          // If there's a specific error about m-line order, we need to recreate the connection
          if (error instanceof Error && error.message.includes('m-lines in subsequent offer')) {
            console.warn('M-line order mismatch detected, recreating connection');
            
            // Close the current connection and create a new one
            if (peerConnections.current[peerId] === pc) {
              pc.close();
              delete peerConnections.current[peerId];
              
              // Clear any pending candidates
              pendingCandidates.current[peerId] = [];
              
              // Recreate with a slight delay to ensure clean state
              setTimeout(() => {
                const newPc = createPeerConnection(peerId, false);
                if (newPc && message.offer) {
                  newPc.setRemoteDescription(new RTCSessionDescription(message.offer))
                    .then(() => newPc.createAnswer())
                    .then(answer => newPc.setLocalDescription(answer))
                    .then(() => {
                      if (socket.current && socket.current.connected) {
                        socket.current.emit('signal', {
                          type: 'answer',
                          answer: newPc.localDescription,
                          target: peerId,
                          from: userId.current
                        });
                      }
                    })
                    .catch(err => {
                      console.error('Error in recreated connection:', err);
                      setError('Failed to handle connection offer: ' + err.message);
                    });
                }
              }, 500);
            }
          } else {
            setError('Failed to handle connection offer: ' + (error instanceof Error ? error.message : String(error)));
          }
        });
    }
  }, [createPeerConnection]);

  // Handle incoming answer
  const handleAnswer = useCallback((message: SignalingMessage) => {
    const peerId = message.from;
    console.log(`Received answer from ${peerId}`);
    
    if (peerConnections.current[peerId] && message.answer) {
      const pc = peerConnections.current[peerId];
      console.log('Setting remote description from answer');
      
      // Check current signaling state
      if (pc.signalingState === 'stable') {
        console.log('Connection already in stable state, ignoring redundant answer');
        return;
      }
      
      pc.setRemoteDescription(new RTCSessionDescription(message.answer))
        .then(() => {
          console.log('Remote description set successfully');
          
          // Apply any pending ICE candidates
          if (pendingCandidates.current[peerId]) {
            console.log(`Applying ${pendingCandidates.current[peerId].length} pending ICE candidates`);
            pendingCandidates.current[peerId].forEach(candidate => {
              peerConnections.current[peerId].addIceCandidate(new RTCIceCandidate(candidate))
                .catch(err => console.error('Error adding pending ICE candidate:', err));
            });
            pendingCandidates.current[peerId] = [];
          }
        })
        .catch(error => {
          console.error('Error handling answer:', error);
          // Try recreating the connection if we can't set the remote description
          if (error instanceof Error && 
            (error.name === 'InvalidStateError' || 
             error.message.includes('Failed to set remote answer sdp'))) {
            console.log('Invalid state, recreating connection');
            
            // Use a slightly longer timeout to avoid racing with other negotiation attempts
            setTimeout(() => {
              if (peerConnections.current[peerId] === pc) {
                // Close existing connection
                pc.close();
                delete peerConnections.current[peerId];
                
                // Recreate with clean state and give it time
                setTimeout(() => {
                  createPeerConnection(peerId, true);
                }, 1000);
              }
            }, 2000);
          } else {
            setError('Failed to handle connection answer: ' + (error instanceof Error ? error.message : String(error)));
          }
        });
    } else {
      console.warn(`Received answer for nonexistent peer connection: ${peerId}`);
    }
  }, [createPeerConnection]);

  // Handle incoming ICE candidate
  const handleIceCandidate = useCallback((message: SignalingMessage) => {
    const peerId = message.from;
    
    if (peerConnections.current[peerId] && message.ice) {
      const pc = peerConnections.current[peerId];
      
      // Only add candidates if we have a remote description
      if (pc.remoteDescription && pc.remoteDescription.type) {
        console.log('Adding ICE candidate');
        pc.addIceCandidate(new RTCIceCandidate(message.ice))
          .catch(error => {
            console.error('Error adding ICE candidate:', error);
            
            // If we get consistent ICE candidate errors, the connection might be corrupted
            if (error.message.includes('Error processing ICE candidate')) {
              // Track failed candidates count for this peer
              if (!pendingCandidates.current[`${peerId}-failed`]) {
                pendingCandidates.current[`${peerId}-failed`] = [];
              }
              
              // Only add if ice is defined (it should be at this point, but to satisfy TypeScript)
              if (message.ice) {
                pendingCandidates.current[`${peerId}-failed`].push(message.ice);
              }
              
              // If we've collected several failed candidates, the connection is likely broken
              if (pendingCandidates.current[`${peerId}-failed`].length > 3) {
                console.warn('Multiple ICE candidate errors detected, connection may be corrupted');
                
                // Only attempt recreation if it's not already in progress
                if (!pendingCandidates.current[`${peerId}-recreating`]) {
                  pendingCandidates.current[`${peerId}-recreating`] = [];
                  
                  // Use a timeout to avoid immediate recreation which could cause race conditions
                  setTimeout(() => {
                    console.log('Recreating problematic connection after ICE failures');
                    
                    // Clean up and recreate
                    if (peerConnections.current[peerId] === pc) {
                      pc.close();
                      delete peerConnections.current[peerId];
                      delete pendingCandidates.current[`${peerId}-failed`];
                      delete pendingCandidates.current[`${peerId}-recreating`];
                      
                      // Recreate with delay to ensure clean state
                      setTimeout(() => {
                        createPeerConnection(peerId, true);
                      }, 1000);
                    }
                  }, 2000);
                }
              }
            }
          });
      } else {
        // Store the candidate to apply later
        console.log('Storing ICE candidate for later');
        if (!pendingCandidates.current[peerId]) {
          pendingCandidates.current[peerId] = [];
        }
        pendingCandidates.current[peerId].push(message.ice);
      }
    } else {
      console.warn(`Received ICE candidate for nonexistent peer connection: ${peerId}`);
    }
  }, [createPeerConnection]);

  // Connect to the signaling server when the component mounts
  useEffect(() => {
    if (roomId) {
      isUnmounting.current = false;
      connectToSignalingServer();
    }
    
    // Clean up when the component unmounts
    return () => {
      isUnmounting.current = true;
      
      // Close the Socket.IO connection
      if (socket.current) {
        socket.current.disconnect();
      }
      
      // Stop sharing
      stopSharing();
      
      // Close all peer connections
      for (const peerId in peerConnections.current) {
        peerConnections.current[peerId].close();
      }
      peerConnections.current = {};
      streamSenders.current = {};
    };
  }, [roomId, connectToSignalingServer, stopSharing]);

  // Watch for peers that are marked as sharing but don't have streams
  useEffect(() => {
    // Identify peers that are marked as sharing (in peerStreams) but have null streams
    const peersWithNullStreams = Object.entries(peerStreams)
      .filter(([_, stream]) => stream === null)
      .map(([peerId]) => peerId);
    
    if (peersWithNullStreams.length > 0) {
      console.log('Peers with null streams:', peersWithNullStreams);
      
      // Set up a periodic ping but with progressive backoff
      const pingInterval = setInterval(() => {
        peersWithNullStreams.forEach(peerId => {
          // Only request if we still have a null stream for this peer
          if (peerId in peerStreams && peerStreams[peerId] === null && 
              socket.current && socket.current.connected) {
            
            // Initialize metadata for this peer if needed
            if (!streamMetadata.current[peerId]) {
              streamMetadata.current[peerId] = {
                streamAttempts: 0,
                pingAttempt: 0,
                iceFailures: 0
              };
            }
            
            // Get the attempt count for this peer
            const pingAttempt = streamMetadata.current[peerId].pingAttempt;
            
            // Apply exponential backoff: first try immediately, then 3s, 9s, etc. up to 5 attempts
            // For simplicity, we'll use a deterministic approach based on pingAttempt
            const shouldPing = pingAttempt === 0 || 
                              pingAttempt === 1 || 
                              pingAttempt === 2 || 
                              pingAttempt % 5 === 0;
            
            if (shouldPing) {
              console.log(`Pinging ${peerId} to request their stream (attempt ${pingAttempt + 1})`);
              
              // Track ping attempts
              streamMetadata.current[peerId].pingAttempt = pingAttempt + 1;
              
              socket.current.emit('signal', {
                type: 'ping',
                target: peerId,
                from: userId.current,
                needsStream: true
              });
              
              // If we have a connection to this peer, only do renegotiation on even attempts
              // This prevents too many simultaneous renegotiations
              if (peerConnections.current[peerId] && pingAttempt % 2 === 0) {
                const pc = peerConnections.current[peerId];
                
                // Only create a new offer if the peer connection is in a stable state
                if (pc.signalingState === 'stable') {
                  // Simple renegotiation using an empty offer
                  pc.createOffer()
                    .then(offer => pc.setLocalDescription(offer))
                    .then(() => {
                      socket.current?.emit('signal', {
                        type: 'offer',
                        offer: pc.localDescription,
                        target: peerId,
                        from: userId.current,
                        needsStream: true
                      });
                    })
                    .catch(err => console.warn('Failed to create ping offer:', err));
                } else {
                  console.log(`Connection with ${peerId} not in stable state, skipping renegotiation`);
                }
              }
            }
          } else if (peerStreams[peerId] !== null && peerId in peerStreams) {
            // Reset ping attempt count when we have a stream
            if (streamMetadata.current[peerId]) {
              streamMetadata.current[peerId].pingAttempt = 0;
            }
          }
        });
      }, 1000); // Check every second, but apply backoff logic within
      
      return () => clearInterval(pingInterval);
    }
  }, [peerStreams]);

  // Helper to select a stream to view
  const selectStream = useCallback((streamOwnerId: string) => {
    setSelectedStream(streamOwnerId);
  }, []);

  // Function to validate and store a stream
  const storeStream = useCallback((peerId: string, stream: MediaStream | null) => {
    // Don't store null streams if we already have a valid stream for this peer
    if (!stream && peerStreams[peerId]) {
      return;
    }
    
    // For actual streams, validate they have video tracks
    if (stream) {
      const videoTracks = stream.getVideoTracks();
      console.log(`Validating stream from ${peerId} - video tracks: ${videoTracks.length}`);
      
      if (videoTracks.length === 0) {
        console.warn(`Stream from ${peerId} has no video tracks, may not be visible`);
      }
      
      // Check if tracks are enabled
      videoTracks.forEach(track => {
        if (!track.enabled) {
          console.warn(`Video track ${track.id} from ${peerId} is disabled`);
        }
      });
    }
    
    // Store the stream and log the update
    setPeerStreams(prev => {
      const updated = {...prev, [peerId]: stream};
      const peerCount = Object.keys(updated).length;
      console.log(`Updated peer streams, now have ${peerCount} peers with streams`);
      
      // Log all peers with streams for debugging
      Object.entries(updated).forEach(([id, str]) => {
        console.log(`- Peer ${id}: ${str ? 'has stream' : 'null stream'}`);
      });
      
      return updated;
    });
  }, [peerStreams]);

  return {
    isConnected,
    isLoading,
    error,
    peers,
    localStream,
    peerStreams,
    selectedStream,
    selectStream, 
    shareScreen,
    stopSharing,
    userId: userId.current
  };
} 