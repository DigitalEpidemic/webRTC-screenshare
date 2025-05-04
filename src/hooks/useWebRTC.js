import { useState, useEffect, useRef, useCallback } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { io } from 'socket.io-client';

export function useWebRTC({ roomId, role }) {
  const [isConnected, setIsConnected] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const [peers, setPeers] = useState([]);
  const [stream, setStream] = useState(null);
  
  const socket = useRef(null);
  const peerConnections = useRef({});
  const localStream = useRef(null);
  const userId = useRef(uuidv4());
  const isUnmounting = useRef(false);

  // Connect to the signaling server
  const connectToSignalingServer = useCallback(() => {
    if (isUnmounting.current) return;
    
    setIsLoading(true);
    setError(null);
    
    try {
      // Determine the Socket.IO URL based on environment
      const baseURL = process.env.NODE_ENV === 'development' 
        ? 'http://localhost:3000' 
        : window.location.origin;
      
      console.log('Connecting to Socket.IO at:', baseURL);
      
      // Close existing connection if any
      if (socket.current) {
        socket.current.disconnect();
      }
      
      // Create new Socket.IO connection with auto-reconnection
      socket.current = io(baseURL, {
        reconnectionAttempts: 5,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        timeout: 20000,
        transports: ['websocket', 'polling']
      });
      
      // Handle connection events
      socket.current.on('connect', () => {
        console.log('Connected to signaling server', socket.current.id);
        
        // Join the room
        socket.current.emit('join', {
          room: roomId,
          userId: userId.current,
          role
        });
      });
      
      socket.current.on('connect_error', (err) => {
        console.error('Connection error:', err);
        setError('Failed to connect to the signaling server: ' + err.message);
      });
      
      socket.current.on('disconnect', (reason) => {
        console.log('Disconnected from signaling server:', reason);
        setIsConnected(false);
        
        if (reason === 'io server disconnect') {
          // The server has forcefully disconnected
          socket.current.connect();
        }
      });
      
      // Handle room information updates
      socket.current.on('room-info', handleRoomInfo);
      
      // Handle WebRTC signaling
      socket.current.on('signal', handleSignalingMessage);
      
    } catch (error) {
      console.error('Error creating Socket.IO connection:', error);
      setError('Failed to create connection: ' + error.message);
      setIsLoading(false);
    }
  }, [roomId, role]);

  // Handle room information
  const handleRoomInfo = useCallback((roomInfo) => {
    console.log('Room info:', roomInfo);
    setPeers(roomInfo.participants.filter(id => id !== userId.current));
    setIsLoading(false);
    setIsConnected(true);
  }, []);

  // Handle messages from the signaling server
  const handleSignalingMessage = useCallback((message) => {
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

  // Share screen (for the sharer)
  const shareScreen = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ 
        video: { 
          cursor: 'always',
          displaySurface: 'monitor'
        },
        audio: true 
      });
      
      localStream.current = stream;
      setStream(stream);
      
      // Handle stream end (user stops sharing)
      stream.getVideoTracks()[0].onended = () => {
        stopSharing();
      };
      
      // Create offers for all peers
      for (const peerId of peers) {
        createPeerConnection(peerId, true);
      }
      
      return stream;
    } catch (error) {
      console.error('Error sharing screen:', error);
      setError('Failed to share screen: ' + error.message);
      return null;
    }
  }, [peers]);

  // Stop sharing
  const stopSharing = useCallback(() => {
    if (localStream.current) {
      localStream.current.getTracks().forEach(track => track.stop());
      localStream.current = null;
      setStream(null);
    }
    
    // Close all peer connections
    for (const peerId in peerConnections.current) {
      peerConnections.current[peerId].close();
      delete peerConnections.current[peerId];
    }
  }, []);

  // Create a new peer connection
  const createPeerConnection = useCallback((peerId, isInitiator) => {
    try {
      if (peerConnections.current[peerId]) {
        return peerConnections.current[peerId];
      }
      
      const pc = new RTCPeerConnection({
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
        ]
      });
      
      // Add tracks to the peer connection (for the sharer)
      if (localStream.current && role === 'sharer') {
        localStream.current.getTracks().forEach(track => {
          pc.addTrack(track, localStream.current);
        });
      }
      
      // Handle ICE candidates
      pc.onicecandidate = (event) => {
        if (event.candidate && socket.current && socket.current.connected) {
          socket.current.emit('signal', {
            ice: event.candidate,
            target: peerId
          });
        }
      };
      
      // Handle connection state changes
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') {
          console.log(`Connected to peer ${peerId}`);
        } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
          console.log(`Disconnected from peer ${peerId}`);
          if (peerConnections.current[peerId]) {
            peerConnections.current[peerId].close();
            delete peerConnections.current[peerId];
          }
        }
      };
      
      // Handle incoming tracks (for the viewer)
      if (role === 'viewer') {
        pc.ontrack = (event) => {
          console.log('Received track:', event.track.kind);
          setStream(event.streams[0]);
        };
      }
      
      // Create and send offer if initiator
      if (isInitiator) {
        pc.createOffer()
          .then(offer => pc.setLocalDescription(offer))
          .then(() => {
            if (socket.current && socket.current.connected) {
              socket.current.emit('signal', {
                offer: pc.localDescription,
                target: peerId
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
      setError('Failed to create peer connection: ' + error.message);
      return null;
    }
  }, [role]);

  // Handle incoming offer
  const handleOffer = useCallback((message) => {
    const peerId = message.from;
    
    // Create a peer connection if it doesn't exist
    const pc = createPeerConnection(peerId, false);
    
    // Set the remote description
    pc.setRemoteDescription(new RTCSessionDescription(message.offer))
      .then(() => pc.createAnswer())
      .then(answer => pc.setLocalDescription(answer))
      .then(() => {
        // Send the answer back
        if (socket.current && socket.current.connected) {
          socket.current.emit('signal', {
            answer: pc.localDescription,
            target: peerId
          });
        }
      })
      .catch(error => {
        console.error('Error handling offer:', error);
        setError('Failed to handle connection offer');
      });
  }, [createPeerConnection]);

  // Handle incoming answer
  const handleAnswer = useCallback((message) => {
    const peerId = message.from;
    
    if (peerConnections.current[peerId]) {
      peerConnections.current[peerId]
        .setRemoteDescription(new RTCSessionDescription(message.answer))
        .catch(error => {
          console.error('Error handling answer:', error);
          setError('Failed to handle connection answer');
        });
    }
  }, []);

  // Handle incoming ICE candidate
  const handleIceCandidate = useCallback((message) => {
    const peerId = message.from;
    
    if (peerConnections.current[peerId]) {
      peerConnections.current[peerId]
        .addIceCandidate(new RTCIceCandidate(message.ice))
        .catch(error => {
          console.error('Error adding ICE candidate:', error);
        });
    }
  }, []);

  // Connect to the signaling server when the component mounts
  useEffect(() => {
    if (roomId && role) {
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
    };
  }, [roomId, role, connectToSignalingServer, stopSharing]);

  return {
    isConnected,
    isLoading,
    error,
    peers,
    stream,
    shareScreen,
    stopSharing,
    userId: userId.current
  };
} 