import { get, onChildAdded, onValue, push, ref, remove, set } from 'firebase/database';
import React, { useCallback, useEffect } from 'react';
import { database } from '../firebase';
import { PeerStreamData, StreamSenders } from './types/webRTC';
import { useFirebaseRefs } from './useFirebaseRefs';

interface UseSignallingServerProps {
  roomId: string | null;
  userId: React.MutableRefObject<string>;
  setPeers: (peers: string[] | ((prev: string[]) => string[])) => void;
  peerConnections: React.MutableRefObject<Record<string, RTCPeerConnection>>;
  createPeerConnection: (peerId: string, isInitiator: boolean) => RTCPeerConnection | null;
  handlePeerLeft: (peerId: string) => void;
  userUnsubscribeFunction: React.MutableRefObject<(() => void) | null>;
  setPeerStreamsWithData: React.Dispatch<React.SetStateAction<Record<string, PeerStreamData>>>;
  setSelectedStream: React.Dispatch<React.SetStateAction<string | null>>;
  peerStreams: Record<string, MediaStream>;
  peerStreamsWithData: Record<string, PeerStreamData>;
  peersUnsubscribeFunction: React.MutableRefObject<(() => void) | null>;
  handleOffer: (offerData: any, offerId?: string) => void;
  offersUnsubscribeFunction: React.MutableRefObject<(() => void) | null>;
  handleAnswer: (answerData: any, answerId?: string) => void;
  answersUnsubscribeFunction: React.MutableRefObject<(() => void) | null>;
  handleIceCandidate: (candidateData: any) => void;
  candidatesUnsubscribeFunction: React.MutableRefObject<(() => void) | null>;
  setError: (error: string | null) => void;
  setIsConnected: React.Dispatch<React.SetStateAction<boolean>>;
  setIsConnecting: React.Dispatch<React.SetStateAction<boolean>>;
  setIsLoading: React.Dispatch<React.SetStateAction<boolean>>;
  streamSenders: React.MutableRefObject<StreamSenders>;
  resetState: () => void;
  isUnmounting: React.MutableRefObject<boolean>;
}

interface UseSignallingServerResult {
  requestStream: (peerId: string) => void;
  connectToRoom: () => void;
  disconnectFromRoom: () => void;
}

export function useSignallingServer({
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
}: UseSignallingServerProps): UseSignallingServerResult {
  // References
  const { getUserRef, getOffersRef, getAnswersRef, getCandidatesRef } = useFirebaseRefs(
    roomId,
    userId.current
  );

  // Request stream from a peer
  const requestStream = useCallback(
    (peerId: string) => {
      console.log(`Requesting stream from ${peerId}`);

      push(getOffersRef(), {
        type: 'request-stream',
        from: userId.current,
        target: peerId,
        timestamp: new Date().toISOString(),
      }).catch(err => {
        console.error(`Error requesting stream from ${peerId}:`, err);
      });
    },
    [getOffersRef]
  );

  // Clean up inactive users
  const cleanupInactiveUsers = useCallback(async () => {
    if (!roomId) return;

    try {
      console.log(`[WebRTC] Checking room status: ${roomId}`);

      // Check if the room exists and has any users
      const roomUsersRef = ref(database, `rooms/${roomId}/users`);
      const snapshot = await get(roomUsersRef);

      // If room exists but has no users, it can be safely deleted
      if (snapshot.exists() && Object.keys(snapshot.val()).length === 0) {
        console.log(`[WebRTC] Room ${roomId} has no users, removing it`);
        const roomRef = ref(database, `rooms/${roomId}`);
        await remove(roomRef);
      }
    } catch (err) {
      console.error('[WebRTC] Error checking room status:', err);
    }
  }, [roomId]);

  // Mark user as inactive when leaving the room or app
  const markUserAsInactive = useCallback(() => {
    if (roomId != null) {
      console.log(`[WebRTC] Removing user ${userId.current} from room ${roomId}`);
      const userRef = ref(database, `rooms/${roomId}/users/${userId.current}`);

      // Also clean up any streaming status
      const streamingRef = ref(database, `rooms/${roomId}/streaming/${userId.current}`);

      // Clean up any coordination data this user initiated
      const coordinationQuery = ref(database, `rooms/${roomId}/coordination`);
      get(coordinationQuery)
        .then(snapshot => {
          if (snapshot.exists()) {
            const coordinationData = snapshot.val();
            // Find and clean up any coordination data initiated by this user
            const promises: Promise<void>[] = [];

            Object.keys(coordinationData).forEach(coordId => {
              if (coordId.startsWith(`${userId.current}-`)) {
                console.log(`[WebRTC] Cleaning up coordination data: ${coordId}`);
                const coordRef = ref(database, `rooms/${roomId}/coordination/${coordId}`);
                promises.push(remove(coordRef));
              }
            });

            if (promises.length > 0) {
              return Promise.all(promises);
            }
          }
          return null;
        })
        .catch(err => {
          console.error('[WebRTC] Error cleaning up coordination data:', err);
        });

      // Remove both the user record and streaming status
      Promise.all([remove(userRef), remove(streamingRef)])
        .then(() => {
          // After removing the user, check if room is now empty and should be removed
          const roomUsersRef = ref(database, `rooms/${roomId}/users`);
          return get(roomUsersRef);
        })
        .then(snapshot => {
          if (snapshot.exists()) {
            const users = snapshot.val();
            if (Object.keys(users).length === 0) {
              // Room is empty, remove it entirely
              console.log(`[WebRTC] Room ${roomId} is now empty, removing it`);
              const roomRef = ref(database, `rooms/${roomId}`);
              return remove(roomRef);
            }
          }
        })
        .catch(err => {
          console.error('[WebRTC] Error removing user or checking room status:', err);
        });
    }
  }, []);

  // Set up all room listeners
  const setupRoomListeners = useCallback(() => {
    if (!roomId) return;

    console.log('[WebRTC] Setting up room listeners');

    try {
      // Listen for users
      const usersRef = ref(database, `rooms/${roomId}/users`);
      const unsubscribeUsers = onValue(usersRef, snapshot => {
        if (isUnmounting.current) return;

        const users = snapshot.val() || {};

        // Check for active users and filter out inactive ones
        const activePeers = Object.keys(users).filter(
          id => id !== userId.current && users[id] && users[id].active === true
        );

        console.log(`[WebRTC] Active peers in room: ${JSON.stringify(activePeers)}`);
        setPeers(activePeers);

        // Initiate connections with new peers
        activePeers.forEach(peerId => {
          // We'll let the peer with the "higher" ID initiate the connection
          const shouldInitiate = userId.current > peerId;
          const existingConnection = peerConnections.current[peerId];

          if (
            !existingConnection ||
            existingConnection.connectionState === 'failed' ||
            existingConnection.connectionState === 'closed'
          ) {
            createPeerConnection(peerId, shouldInitiate);
          }
        });

        // Clean up connections for peers that are no longer active
        Object.keys(peerConnections.current).forEach(peerId => {
          if (!activePeers.includes(peerId)) {
            handlePeerLeft(peerId);
          }
        });
      });

      userUnsubscribeFunction.current = unsubscribeUsers;

      // Listen for streaming status updates - needed to detect existing shares
      const streamingRef = ref(database, `rooms/${roomId}/streaming`);
      const unsubscribeStreaming = onValue(streamingRef, snapshot => {
        if (isUnmounting.current) return;

        const streamingStatus = snapshot.val() || {};
        console.log('[WebRTC] Streaming status update:', streamingStatus);

        // Cross-reference with active users to detect stale streamers
        const usersRef = ref(database, `rooms/${roomId}/users`);
        get(usersRef)
          .then(usersSnapshot => {
            const activeUsers = usersSnapshot.val() || {};
            const activeUserIds = Object.keys(activeUsers);

            // Process streaming status updates & cleanup stale entries in one pass
            Object.keys(streamingStatus).forEach(async peerId => {
              // Check if this streaming user is still active in the room
              const isUserStillActive = activeUserIds.includes(peerId);

              // CASE 1: User is no longer in the room but still marked as streaming
              if (!isUserStillActive && streamingStatus[peerId] === true) {
                console.log(
                  `[WebRTC] Cleaning up stale streaming status for disconnected user: ${peerId}`
                );

                // Remove stale streaming status
                const staleStreamingRef = ref(database, `rooms/${roomId}/streaming/${peerId}`);
                await remove(staleStreamingRef);

                // Update UI
                setPeerStreamsWithData(prev => {
                  if (!prev[peerId]) return prev;
                  return {
                    ...prev,
                    [peerId]: {
                      ...prev[peerId],
                      isSharing: false,
                      mediaType: undefined,
                    },
                  };
                });

                // Reset selected stream if we were viewing this stale streamer
                setSelectedStream(prev => (prev === peerId ? null : prev));

                // Skip further processing for this peer
                return;
              }

              // CASE 2: Regular active peer that's sharing their screen
              if (peerId !== userId.current && streamingStatus[peerId] === true) {
                console.log(`[WebRTC] Peer ${peerId} is sharing their screen`);

                // Update the UI to show they're sharing even before we get their stream
                setPeerStreamsWithData(prev => {
                  // Don't overwrite if we already have this peer's data
                  if (prev[peerId]?.streamReady) return prev;

                  return {
                    ...prev,
                    [peerId]: {
                      ...prev[peerId],
                      isSharing: true,
                      mediaType: 'screen',
                      streamReady: prev[peerId]?.stream ? true : false,
                    },
                  };
                });

                // If we don't have their stream yet, request it
                if (!peerStreams[peerId] || !peerStreamsWithData[peerId]?.streamReady) {
                  console.log(`[WebRTC] Requesting stream from already sharing peer: ${peerId}`);

                  // Wait a moment for connections to be fully established
                  setTimeout(() => {
                    requestStream(peerId);

                    // Send a second request after a delay which often helps with first-time connection
                    setTimeout(() => {
                      console.log(`[WebRTC] Sending second stream request to ${peerId}`);
                      requestStream(peerId);
                    }, 2000);
                  }, 1000);
                }
              }
              // CASE 3: Peer explicitly stopped sharing
              else if (peerId !== userId.current && streamingStatus[peerId] === false) {
                // When a peer stops sharing, update our UI
                setPeerStreamsWithData(prev => {
                  if (!prev[peerId]) return prev;

                  return {
                    ...prev,
                    [peerId]: {
                      ...prev[peerId],
                      isSharing: false,
                      mediaType: undefined,
                    },
                  };
                });
              }
            });
          })
          .catch(err => {
            console.error('[WebRTC] Error checking users for stale streamers:', err);
          });
      });

      // Add this to the cleanup list
      peersUnsubscribeFunction.current = unsubscribeStreaming;

      // Listen for offers and clean up processed ones
      const offersRef = getOffersRef();
      const unsubscribeOffers = onChildAdded(offersRef, snapshot => {
        const offerData = snapshot.val();
        if (!offerData) return;

        // Only process offers intended for us
        if (offerData.target === userId.current) {
          handleOffer(offerData, snapshot.key || '');

          // Clean up processed offers after a delay (to prevent race conditions)
          setTimeout(() => {
            if (snapshot.key) {
              remove(ref(database, `rooms/${roomId}/offers/${snapshot.key}`)).catch(err =>
                console.error('[WebRTC] Error removing processed offer:', err)
              );
            }
          }, 5000);
        }
      });

      offersUnsubscribeFunction.current = unsubscribeOffers;

      // Listen for answers
      const answersRef = ref(database, `rooms/${roomId}/answers`);
      const unsubscribeAnswers = onChildAdded(answersRef, snapshot => {
        if (isUnmounting.current) return;

        const answerData = snapshot.val();
        if (!answerData || answerData.target !== userId.current) return;

        handleAnswer(answerData, snapshot.key || '');

        // Clean up after processing
        if (snapshot.key) {
          remove(ref(database, `rooms/${roomId}/answers/${snapshot.key}`)).catch(err =>
            console.error('[WebRTC] Error removing processed answer:', err)
          );
        }
      });

      answersUnsubscribeFunction.current = unsubscribeAnswers;

      // Listen for ICE candidates
      const candidatesRef = getCandidatesRef();
      const unsubscribeCandidates = onChildAdded(candidatesRef, snapshot => {
        const candidateData = snapshot.val();
        if (!candidateData || candidateData.target !== userId.current) return;

        handleIceCandidate(candidateData);

        // Clean up after processing
        if (snapshot.key) {
          remove(ref(database, `rooms/${roomId}/candidates/${snapshot.key}`)).catch(err =>
            console.error('[WebRTC] Error removing processed candidate:', err)
          );
        }
      });

      candidatesUnsubscribeFunction.current = unsubscribeCandidates;

      console.log('[WebRTC] Room listeners set up successfully');
    } catch (error) {
      console.error('[WebRTC] Error setting up room listeners:', error);
      setError(
        `Failed to set up room listeners: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }, [
    roomId,
    getOffersRef,
    getAnswersRef,
    getCandidatesRef,
    createPeerConnection,
    handleOffer,
    handleAnswer,
    handleIceCandidate,
    handlePeerLeft,
  ]);

  // Connect to the room
  const connectToRoom = useCallback(() => {
    if (!roomId || isUnmounting.current) {
      console.log('[WebRTC] Not connecting - unmounting or no roomId', {
        roomId,
        isUnmounting: isUnmounting.current,
      });
      return;
    }

    console.log('[WebRTC] Connecting to room:', roomId);

    // Set connecting state
    setIsConnecting(true);
    setIsLoading(true);
    setError(null);

    try {
      // First clean up any stale users
      cleanupInactiveUsers()
        .then(() => {
          // Register user
          const userRef = getUserRef();
          if (!userRef) {
            console.error('[WebRTC] Failed to get user reference');
            setIsConnecting(false);
            setIsLoading(false);
            return;
          }

          // Clean up any previous user entries with same ID
          markUserAsInactive();

          // Add user to room
          set(userRef, {
            joined: new Date().toISOString(),
            active: true,
          })
            .then(() => {
              console.log('[WebRTC] User registered successfully');

              // Mark the user inactive when browser closes
              window.addEventListener('beforeunload', markUserAsInactive);

              // Set up user listeners
              setupRoomListeners();

              // Update connection state
              setIsConnected(true);
              setIsConnecting(false);
              setIsLoading(false);
            })
            .catch(err => {
              console.error('[WebRTC] Error registering user:', err);
              setError(`Failed to register user: ${err.message}`);
              setIsConnecting(false);
              setIsLoading(false);
            });
        })
        .catch(err => {
          console.error('[WebRTC] Error during inactive user cleanup:', err);
          // Continue with connection even if cleanup fails
          // Rest of the connection code...
        });
    } catch (error) {
      console.error('[WebRTC] Error connecting to room:', error);
      setError(
        `Failed to connect to room: ${error instanceof Error ? error.message : String(error)}`
      );

      // Only update these states if we're not unmounting
      if (!isUnmounting.current) {
        setIsConnecting(false);
        setIsLoading(false);
      }
    }
  }, [roomId, getUserRef, markUserAsInactive, cleanupInactiveUsers]);

  // Disconnect from room
  const disconnectFromRoom = useCallback(() => {
    console.log('[WebRTC] Disconnecting from room');

    // Remove beforeunload listener
    window.removeEventListener('beforeunload', markUserAsInactive);

    // Mark user as inactive
    markUserAsInactive();

    // If we are unmounting, we don't need to update any state
    if (!isUnmounting.current) {
      setIsConnected(false);
      setIsConnecting(false);
      setIsLoading(false);
    }

    // Close and terminate all peer connections
    const peerIds = Object.keys(peerConnections.current);
    if (peerIds.length > 0) {
      console.log(`[WebRTC] Closing ${peerIds.length} peer connections`);

      peerIds.forEach(peerId => {
        const pc = peerConnections.current[peerId];
        if (pc) {
          try {
            // Stop all transceivers if they exist
            if (pc.getTransceivers) {
              pc.getTransceivers().forEach(transceiver => {
                try {
                  if (transceiver.stop) {
                    transceiver.stop();
                  }
                } catch (e) {
                  console.warn(`Error stopping transceiver: ${e}`);
                }
              });
            }

            // Remove all tracks explicitly
            if (streamSenders.current[peerId]) {
              streamSenders.current[peerId].forEach(sender => {
                try {
                  const track = sender.track;
                  if (track) {
                    track.stop();
                    pc.removeTrack(sender);
                  }
                } catch (e) {
                  console.warn(`Error removing track: ${e}`);
                }
              });
            }

            // Close the connection
            pc.close();
          } catch (e) {
            console.warn(`Error closing peer connection: ${e}`);
          }
        }
      });
    }

    // Clean up all references
    peerConnections.current = {};
    streamSenders.current = {};

    // Remove Firebase listeners
    if (offersUnsubscribeFunction.current) {
      offersUnsubscribeFunction.current();
      offersUnsubscribeFunction.current = null;
    }

    if (answersUnsubscribeFunction.current) {
      answersUnsubscribeFunction.current();
      answersUnsubscribeFunction.current = null;
    }

    if (candidatesUnsubscribeFunction.current) {
      candidatesUnsubscribeFunction.current();
      candidatesUnsubscribeFunction.current = null;
    }

    if (userUnsubscribeFunction.current) {
      userUnsubscribeFunction.current();
      userUnsubscribeFunction.current = null;
    }

    if (peersUnsubscribeFunction.current) {
      peersUnsubscribeFunction.current();
      peersUnsubscribeFunction.current = null;
    }

    // Reset state
    resetState();
  }, [markUserAsInactive, resetState]);

  // Handle component unmounting or page refresh in a completely separate effect
  useEffect(() => {
    // Add a page unload listener to ensure user is marked inactive
    const handleBeforeUnload = () => {
      console.log('[WebRTC] Page is being unloaded, cleaning up');
      isUnmounting.current = true;
      markUserAsInactive();
    };

    window.addEventListener('beforeunload', handleBeforeUnload);

    // Clean up everything when component unmounts
    return () => {
      console.log('[WebRTC] Component unmounting, cleaning up');
      isUnmounting.current = true;
      window.removeEventListener('beforeunload', handleBeforeUnload);
      disconnectFromRoom();

      // Also clean up any lingering user entries using our updated removal method
      if (roomId) {
        markUserAsInactive();
      }
    };
  }, [disconnectFromRoom, markUserAsInactive]);

  return { requestStream, connectToRoom, disconnectFromRoom };
}
