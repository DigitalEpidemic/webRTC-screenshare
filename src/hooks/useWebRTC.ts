import { useState, useEffect, useRef, useCallback } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { io, Socket } from 'socket.io-client';

interface UseWebRTCProps {
  roomId: string;
}

interface PeerStreams {
  [peerId: string]: MediaStream;
}

interface StreamSenders {
  [peerId: string]: RTCRtpSender[];
}

interface PendingCandidates {
  [peerId: string]: RTCIceCandidateInit[];
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
}

interface RoomInfo {
  participants: string[];
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
        
        // If a peer stopped streaming, remove their stream from our state
        if (!isStreaming) {
          setPeerStreams(prev => {
            const newStreams = {...prev};
            delete newStreams[streamingUserId];
            return newStreams;
          });
          
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
    
    setIsLoading(false);
    setIsConnected(true);
  }, []);

  // Handle messages from the signaling server
  const handleSignalingMessage = useCallback((message: SignalingMessage) => {
    console.log('Received signal:', message.type || 'ice candidate', 'from', message.from);
    
    if (message.offer) {
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
      
      // Add stream to all peer connections
      for (const peerId in peerConnections.current) {
        const pc = peerConnections.current[peerId];
        
        // Remove any existing tracks first
        removeTracksFromConnection(peerId);
        
        // Add the new tracks
        addTracksToConnection(pc, peerId);
      }
      
      // Notify peers about stream
      if (socket.current && socket.current.connected) {
        console.log('Notifying server about started stream');
        socket.current.emit('stream-started', {
          userId: userId.current,
          roomId
        });
      }
      
      return stream;
    } catch (error) {
      console.error('Error sharing screen:', error);
      setError('Failed to share screen: ' + (error instanceof Error ? error.message : String(error)));
      return null;
    }
  }, [roomId, removeTracksFromConnection, addTracksToConnection]);

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
      
      const pc = new RTCPeerConnection({
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' }
        ],
        iceCandidatePoolSize: 10
      });
      
      // Initialize pending candidates array
      pendingCandidates.current[peerId] = [];
      
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
      
      // Log ICE connection state changes
      pc.oniceconnectionstatechange = () => {
        console.log(`ICE connection state with ${peerId}: ${pc.iceConnectionState}`);
        
        // If ICE connection failed, try reconnecting
        if (pc.iceConnectionState === 'failed') {
          console.log(`ICE connection with ${peerId} failed, attempting to restart`);
          pc.restartIce();
        }
      };
      
      // Handle connection state changes
      pc.onconnectionstatechange = () => {
        console.log(`Connection state with ${peerId}: ${pc.connectionState}`);
        
        if (pc.connectionState === 'connected') {
          console.log(`Connected to peer ${peerId}`);
          
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
        setPeerStreams(prev => ({
          ...prev,
          [peerId]: event.streams[0]
        }));
        
        // If this is the first incoming stream, select it by default
        if (!selectedStream) {
          setSelectedStream(peerId);
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
    console.log(`Received offer from ${peerId}, creating answer`);
    
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
      // Set the remote description
      pc.setRemoteDescription(new RTCSessionDescription(message.offer))
        .then(() => {
          console.log('Remote description set, creating answer');
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
          setError('Failed to handle connection offer: ' + (error instanceof Error ? error.message : String(error)));
        });
    }
  }, [createPeerConnection]);

  // Handle incoming answer
  const handleAnswer = useCallback((message: SignalingMessage) => {
    const peerId = message.from;
    console.log(`Received answer from ${peerId}`);
    
    if (peerConnections.current[peerId] && message.answer) {
      console.log('Setting remote description from answer');
      peerConnections.current[peerId]
        .setRemoteDescription(new RTCSessionDescription(message.answer))
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
          if (error instanceof Error && error.name === 'InvalidStateError') {
            console.log('Invalid state, recreating connection');
            setTimeout(() => {
              createPeerConnection(peerId, true);
            }, 1000);
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
  }, []);

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

  // Helper to select a stream to view
  const selectStream = useCallback((streamOwnerId: string) => {
    setSelectedStream(streamOwnerId);
  }, []);

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