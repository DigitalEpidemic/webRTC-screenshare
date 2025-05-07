import { onValue, push, ref, remove, set } from 'firebase/database';
import { useCallback, useEffect, useRef, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { database } from '../firebase';
import {
  PeerConnections,
  PeerStreamData,
  StreamSenders,
  UseWebRTCProps,
  UseWebRTCResult,
} from './types/webRTC';
import { useFirebaseRefs } from './useFirebaseRefs';
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

  // Get Firebase references
  const { getOffersRef, getAnswersRef } = useFirebaseRefs(roomId, userId.current);
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

  // Handle incoming offer
  const handleOffer = useCallback(
    async (offerData: any, offerId?: string) => {
      const peerId = offerData.from;
      console.log(`[WebRTC] Received offer from ${peerId}`, offerData);

      // Check if we've already processed this offer
      if (offerId && processedOfferIds.current.has(offerId)) {
        console.log(`[WebRTC] Skipping already processed offer ${offerId}`);
        return;
      }

      // Add to processed set if we have an ID
      if (offerId) {
        processedOfferIds.current.add(offerId);
      }

      // Prevent concurrent processing
      if (processingOffer.current) {
        console.log('[WebRTC] Already processing an offer, deferring');
        setTimeout(() => handleOffer(offerData, offerId), 500);
        return;
      }

      processingOffer.current = true;

      try {
        // For handling hasScreen flag in offers - this indicates screen sharing
        const hasScreen = offerData.hasScreen === true;

        // Special case: we're also screen sharing and this is a screen sharing offer
        // This is likely to cause an m-line mismatch, so we need special handling
        if (hasScreen && localStreamRef.current) {
          console.log(`[WebRTC] Both sides are trying to share screen - coordinating transition`);

          // Close existing connection completely, regardless of state
          if (peerConnections.current[peerId]) {
            console.log(`[WebRTC] Closing existing connection for conflict resolution`);
            peerConnections.current[peerId].close();
            delete peerConnections.current[peerId];
          }

          // Create a new connection with the peer
          const newPc = createPeerConnection(peerId, false);
          if (!newPc) {
            processingOffer.current = false;
            setError(`Failed to create new connection during conflict resolution`);
            return;
          }

          // Signal UI that peer is sharing screen
          setPeerStreamsWithData(prev => {
            const newStreamsData = { ...prev };
            if (!newStreamsData[peerId]) {
              newStreamsData[peerId] = {
                isSharing: true,
                mediaType: 'screen',
                streamReady: false,
              };
            } else {
              newStreamsData[peerId] = {
                ...newStreamsData[peerId],
                isSharing: true,
                mediaType: 'screen',
                streamReady: newStreamsData[peerId]?.stream ? true : false,
              };
            }
            return newStreamsData;
          });

          // Wait for the connection to initialize before continuing
          await new Promise(resolve => setTimeout(resolve, 1000));

          // Now try to set the remote description on the fresh connection
          try {
            await newPc.setRemoteDescription(new RTCSessionDescription(offerData.sdp));
          } catch (error: any) {
            console.error(
              '[WebRTC] Error setting remote description during conflict resolution:',
              error
            );
            processingOffer.current = false;
            setError(
              `Failed to handle simultaneous screen sharing: ${error?.message || 'Unknown error'}`
            );
            return;
          }

          // Create and send answer
          try {
            const answer = await newPc.createAnswer();
            await newPc.setLocalDescription(answer);

            if (!newPc.localDescription) {
              throw new Error('No local description to send');
            }

            console.log(`[WebRTC] Sending answer after conflict resolution to ${peerId}`);

            await push(getAnswersRef(), {
              from: userId.current,
              target: peerId,
              sdp: {
                type: newPc.localDescription.type,
                sdp: newPc.localDescription.sdp,
              },
              timestamp: new Date().toISOString(),
            });

            processingOffer.current = false;
            return;
          } catch (error: any) {
            console.error(
              '[WebRTC] Error creating/sending answer during conflict resolution:',
              error
            );
            processingOffer.current = false;
            setError(
              `Failed to handle simultaneous screen sharing: ${error?.message || 'Unknown error'}`
            );
            return;
          }
        }

        if (hasScreen) {
          console.log(`[WebRTC] Offer includes screen share from ${peerId}`);

          // If we're in a state where connection isn't suitable for receiving a screen share
          // offer, reset the connection completely
          let pc = peerConnections.current[peerId];
          if (pc && pc.signalingState !== 'stable') {
            console.log(
              `[WebRTC] Connection state not stable for screen share, resetting connection`
            );
            pc = resetAndRecreateConnection(peerId, false) || pc;

            // Delay processing to allow connection setup
            setTimeout(() => {
              processingOffer.current = false;
              handleOffer(offerData, offerId);
            }, 1000);
            return;
          }

          // Update UI to show that peer is screen sharing
          setPeerStreamsWithData(prev => {
            const newStreamsData = { ...prev };
            if (!newStreamsData[peerId]) {
              newStreamsData[peerId] = {
                isSharing: true,
                mediaType: 'screen',
                streamReady: false,
              };
            } else {
              newStreamsData[peerId] = {
                ...newStreamsData[peerId],
                isSharing: true,
                mediaType: 'screen',
                streamReady: newStreamsData[peerId]?.stream ? true : false,
              };
            }
            return newStreamsData;
          });
        }

        // Special handling for stream requests
        if (offerData.type === 'request-stream' && localStreamRef.current) {
          console.log(`[WebRTC] Received stream request from ${peerId}`);

          // Create a connection if it doesn't exist
          let pc = peerConnections.current[peerId];
          if (!pc || pc.connectionState === 'closed' || pc.connectionState === 'failed') {
            const newPc = createPeerConnection(peerId, true);
            if (!newPc) {
              processingOffer.current = false;
              return;
            }
            pc = newPc;
          }

          // Extra: force a new stream connection on request-stream to fix the first share issue
          if (localStreamRef.current && pc) {
            // We have a stream and connection - ensure tracks are added
            console.log(
              `[WebRTC] Request-stream received with active local stream - ensuring track is sent to ${peerId}`
            );

            // Try a different approach - completely recreate the connection
            if (
              pc.connectionState !== 'connected' ||
              !streamSenders.current[peerId] ||
              streamSenders.current[peerId].length === 0
            ) {
              console.log(
                `[WebRTC] Connection not fully established or no senders - recreating to fix first-share issue`
              );

              // Close the existing connection
              pc.close();
              delete peerConnections.current[peerId];

              // Create a fresh connection
              const newPc = createPeerConnection(peerId, true);
              if (!newPc) {
                processingOffer.current = false;
                return;
              }

              pc = newPc;

              // Wait a bit before proceeding to ensure the connection is ready
              setTimeout(() => {
                // Now create and send a special offer
                if (pc.signalingState === 'stable') {
                  console.log(`[WebRTC] Creating special reconnection offer for ${peerId}`);
                  pc.createOffer()
                    .then(offer => pc.setLocalDescription(offer))
                    .then(() => {
                      if (!pc.localDescription) return;

                      return push(getOffersRef(), {
                        from: userId.current,
                        target: peerId,
                        sdp: {
                          type: pc.localDescription.type,
                          sdp: pc.localDescription.sdp,
                        },
                        hasScreen: true, // Mark this as screen sharing
                        timestamp: new Date().toISOString(),
                      });
                    })
                    .catch(err =>
                      console.error(`[WebRTC] Error sending reconnection offer to ${peerId}:`, err)
                    );
                }
              }, 1000);

              // Let Firebase mark this process complete
              processingOffer.current = false;
              return;
            }

            // Try the original approach with better track handling as a fallback
            setTimeout(() => {
              try {
                // Clean up any existing senders first more carefully
                if (streamSenders.current[peerId] && streamSenders.current[peerId].length > 0) {
                  console.log(
                    `[WebRTC] Removing ${streamSenders.current[peerId].length} existing senders for ${peerId}`
                  );

                  // First remove track senders
                  streamSenders.current[peerId].forEach(sender => {
                    try {
                      pc.removeTrack(sender);
                    } catch (err) {
                      // Ignore errors here, just log
                      console.warn(`[WebRTC] Error removing track from ${peerId}:`, err);
                    }
                  });

                  // Clear the senders array
                  streamSenders.current[peerId] = [];

                  // Wait briefly before adding tracks
                  setTimeout(() => {
                    if (localStreamRef.current) {
                      console.log(
                        `[WebRTC] Adding ${localStreamRef.current.getTracks().length} tracks after cleanup`
                      );

                      // Add all tracks with a forced reconnection approach
                      localStreamRef.current.getTracks().forEach(track => {
                        try {
                          if (peerConnections.current[peerId] === pc) {
                            const sender = pc.addTrack(track, localStreamRef.current!);
                            streamSenders.current[peerId].push(sender);

                            // Create a new offer after adding tracks
                            setTimeout(() => {
                              if (pc.signalingState === 'stable') {
                                console.log(
                                  `[WebRTC] Creating explicit offer for ${peerId} after stream request`
                                );
                                pc.createOffer()
                                  .then(offer => pc.setLocalDescription(offer))
                                  .then(() => {
                                    if (!pc.localDescription) return;

                                    return push(getOffersRef(), {
                                      from: userId.current,
                                      target: peerId,
                                      sdp: {
                                        type: pc.localDescription.type,
                                        sdp: pc.localDescription.sdp,
                                      },
                                      hasScreen: true, // Mark this as screen sharing
                                      timestamp: new Date().toISOString(),
                                    });
                                  })
                                  .catch(err =>
                                    console.error(
                                      `[WebRTC] Error sending offer after track cleanup to ${peerId}:`,
                                      err
                                    )
                                  );
                              }
                            }, 500);
                          }
                        } catch (err) {
                          console.error(`[WebRTC] Failed to add track during stream request:`, err);
                        }
                      });
                    }
                  }, 500);
                } else {
                  // No existing senders - just add tracks
                  if (localStreamRef.current) {
                    localStreamRef.current.getTracks().forEach(track => {
                      try {
                        if (peerConnections.current[peerId] === pc) {
                          console.log(
                            `[WebRTC] Adding track to connection without previous senders`
                          );
                          const sender = pc.addTrack(track, localStreamRef.current!);
                          if (!streamSenders.current[peerId]) {
                            streamSenders.current[peerId] = [];
                          }
                          streamSenders.current[peerId].push(sender);

                          // Create a new offer after adding tracks
                          setTimeout(() => {
                            if (pc.signalingState === 'stable') {
                              console.log(
                                `[WebRTC] Creating explicit offer for ${peerId} after stream request`
                              );
                              pc.createOffer()
                                .then(offer => pc.setLocalDescription(offer))
                                .then(() => {
                                  if (!pc.localDescription) return;

                                  return push(getOffersRef(), {
                                    from: userId.current,
                                    target: peerId,
                                    sdp: {
                                      type: pc.localDescription.type,
                                      sdp: pc.localDescription.sdp,
                                    },
                                    hasScreen: true, // Mark this as screen sharing
                                    timestamp: new Date().toISOString(),
                                  });
                                })
                                .catch(err =>
                                  console.error(
                                    `[WebRTC] Error sending offer after stream request to ${peerId}:`,
                                    err
                                  )
                                );
                            }
                          }, 500);
                        }
                      } catch (err) {
                        console.error(`[WebRTC] Failed to add track during stream request:`, err);
                      }
                    });
                  }
                }
              } catch (err) {
                console.error(`[WebRTC] Error processing stream request:`, err);
              }
            }, 500);
          }

          processingOffer.current = false;
          return;
        }

        // Handle stopped-sharing notification
        if (offerData.type === 'stopped-sharing') {
          console.log(`[WebRTC] Received stopped-sharing notification from ${peerId}`);

          // Update peerStreamsWithData to mark this peer as no longer sharing
          setPeerStreamsWithData(prev => {
            const newStreamsData = { ...prev };
            if (newStreamsData[peerId]) {
              newStreamsData[peerId] = {
                ...newStreamsData[peerId],
                isSharing: false,
                mediaType: undefined,
              };
            }
            return newStreamsData;
          });

          // If we're currently viewing this peer's stream, let's switch to another sharing peer
          if (selectedStream === peerId) {
            // Find another peer who is sharing
            const sharingPeerId = Object.entries(peerStreamsWithData).find(
              ([id, data]) => id !== peerId && data?.isSharing
            )?.[0];

            if (sharingPeerId) {
              console.log(
                `Switching view from stopped ${peerId} to another sharing peer ${sharingPeerId}`
              );
              selectStream(sharingPeerId);
            } else {
              console.log(`No other sharing peers found, clearing selected stream`);
              selectStream(null);
            }
          }

          processingOffer.current = false;
          return;
        }

        // Special handling for pre-screen-share notifications
        if (offerData.type === 'pre-screen-share') {
          console.log(`[WebRTC] Received pre-screen-share notification from ${peerId}`);

          // Check if this is part of the new coordination system
          if (offerData.coordinationId) {
            console.log(`[WebRTC] Acknowledging coordination request ${offerData.coordinationId}`);

            // Send acknowledgment by updating the coordination acks
            const ackRef = ref(
              database,
              `rooms/${roomId}/coordination/${offerData.coordinationId}/acks/${userId.current}`
            );
            await set(ackRef, {
              timestamp: new Date().toISOString(),
              status: 'acknowledged',
            }).catch(err => {
              console.error(`[WebRTC] Error acknowledging coordination:`, err);
            });

            // If we're also trying to share screen, we need to coordinate
            if (localStreamRef.current) {
              // Decide who goes first based on user ID (higher ID wins)
              const myId = userId.current || '';
              const peerId = offerData.from;

              // If our ID is lower, we should wait and let peer share first
              if (myId < peerId) {
                console.log(
                  `[WebRTC] Our ID (${myId}) is lower than peer's (${peerId}), will wait for their share`
                );

                // Listen for their sharing status
                const peerSharingRef = ref(database, `rooms/${roomId}/streaming/${peerId}`);
                const unsubscribe = onValue(peerSharingRef, snapshot => {
                  if (snapshot.val() === true) {
                    console.log(`[WebRTC] Peer ${peerId} has started sharing, we'll wait`);
                    unsubscribe();

                    setError(
                      'Cannot share screen - another user is already sharing. Please wait until they finish.'
                    );
                  }
                });

                // Set a timeout to clean up listener if peer doesn't share
                setTimeout(() => {
                  unsubscribe();
                }, 10000); // 10 seconds max wait
              } else {
                console.log(
                  `[WebRTC] Our ID (${myId}) is higher than peer's (${peerId}), we'll proceed with our share`
                );
              }
            }
          } else {
            // Handle legacy pre-screen-share messages for backward compatibility
            // If we're also trying to share screen, we need to coordinate
            if (localStreamRef.current) {
              // Decide who goes first based on user ID (higher ID wins)
              const myId = userId.current || '';
              const peerId = offerData.from;

              // If our ID is lower, we should wait and let peer share first
              if (myId < peerId) {
                console.log(
                  `[WebRTC] Our ID (${myId}) is lower than peer's (${peerId}), will wait for their share`
                );

                // Wait to see if they actually share
                await new Promise(resolve => setTimeout(resolve, 2000));

                // Check if they've shared their screen
                const peerIsSharing = peerStreamsWithData[peerId]?.isSharing === true;

                if (peerIsSharing) {
                  console.log(
                    `[WebRTC] Peer ${peerId} is now sharing, will wait before trying to share`
                  );
                  // We'll wait before trying again
                  setError(
                    'Cannot share screen - another user is already sharing. Please wait until they finish.'
                  );
                  processingOffer.current = false;
                  return;
                }
              } else {
                console.log(
                  `[WebRTC] Our ID (${myId}) is higher than peer's (${peerId}), we'll proceed with our share`
                );
              }
            }
          }

          processingOffer.current = false;
          return;
        }

        // Handle normal SDP offers
        let pc = peerConnections.current[peerId];
        if (!pc || pc.connectionState === 'closed' || pc.connectionState === 'failed') {
          const newPc = createPeerConnection(peerId, false);
          if (!newPc) {
            processingOffer.current = false;
            return;
          }
          pc = newPc;
        }

        // Validate that we have a valid SDP offer
        const offer = offerData.sdp;
        if (!offer || !offer.type || !offer.sdp) {
          console.error('[WebRTC] Invalid offer received:', offer);
          console.dir(offerData, { depth: null });

          // If this is a plain signaling message without SDP (possible during connection setup)
          if (!offer && !offerData.type) {
            processingOffer.current = false;
            return;
          }

          setError(`Invalid offer received from peer ${peerId}`);
          processingOffer.current = false;
          return;
        }

        // Check if we're already processing this offer type or are in a conflicting state
        // Expanded the valid states and added handling for difficult situations
        const validStates = ['stable', 'have-remote-offer'];
        if (!validStates.includes(pc.signalingState)) {
          console.warn(
            `[WebRTC] Connection with ${peerId} not in valid state to process offer (current: ${pc.signalingState})`
          );

          // If both sides are trying to send offers simultaneously (common during screen sharing)
          // Handle this scenario by creating a completely new connection to avoid m-line conflicts
          if (pc.signalingState === 'have-local-offer' && hasScreen) {
            console.log(
              `[WebRTC] Both sides are trying to share screen simultaneously, recreating connection`
            );

            // Close and recreate the connection
            pc.close();
            delete peerConnections.current[peerId];

            // Create a new connection without initiating an offer
            // Let the peer who wants to share screen be the initiator
            const newPc = createPeerConnection(peerId, false);
            if (!newPc) {
              processingOffer.current = false;
              return;
            }

            // Reset the connection state and try again
            pc = newPc;

            // Retry with the new connection after a short delay
            setTimeout(() => {
              processingOffer.current = false;
              handleOffer(offerData, offerId);
            }, 1000);
            return;
          }

          // Reset the offer processing state
          processingOffer.current = false;
          return;
        }

        console.log(
          `[WebRTC] Setting remote description for offer from ${peerId}, signaling state: ${pc.signalingState}`
        );

        // Handle rollback if needed for Chromium-based browsers
        if (pc.signalingState === 'have-local-offer') {
          console.log(`[WebRTC] Rolling back local description to handle incoming offer`);
          try {
            // @ts-ignore - Rollback is standard but TypeScript doesn't recognize it
            await pc.setLocalDescription({ type: 'rollback' });
          } catch (err) {
            console.warn(`[WebRTC] Rollback not supported, trying to handle anyway:`, err);
          }
        }

        try {
          // Now set the remote offer and create answer
          await pc.setRemoteDescription(new RTCSessionDescription(offer));
        } catch (error: any) {
          console.error('[WebRTC] Error setting remote description:', error);

          // Handle M-line order mismatch errors more gracefully
          if (
            error.message &&
            error.message.includes("m-lines in subsequent offer doesn't match order")
          ) {
            console.log(`[WebRTC] M-line order mismatch, recreating connection with ${peerId}`);

            // Close and recreate the connection
            pc.close();
            delete peerConnections.current[peerId];

            // Create a new connection
            const newPc = createPeerConnection(peerId, false);
            if (!newPc) {
              processingOffer.current = false;
              setError(`Failed to recreate connection after m-line mismatch`);
              return;
            }

            pc = newPc;

            // Try setting the remote description on the new connection
            try {
              await pc.setRemoteDescription(new RTCSessionDescription(offer));
            } catch (secondError: any) {
              console.error(
                '[WebRTC] Still failed to set remote description after recreating connection:',
                secondError
              );
              processingOffer.current = false;
              setError(`Failed to handle offer: ${secondError.message || 'Unknown error'}`);
              return;
            }
          } else {
            // For other errors, just propagate them
            processingOffer.current = false;
            setError(`Failed to handle offer: ${error.message || 'Unknown error'}`);
            return;
          }
        }

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        console.log(`[WebRTC] Sending answer to ${peerId}`);

        if (!pc.localDescription) {
          throw new Error('No local description to send');
        }

        const sdpData = {
          type: pc.localDescription.type,
          sdp: pc.localDescription.sdp,
        };

        await push(getAnswersRef(), {
          from: userId.current,
          target: peerId,
          sdp: sdpData,
          timestamp: new Date().toISOString(),
        });

        // If this was a screen sharing offer, ensure it's set in the state
        if (hasScreen) {
          // Check the connection for tracks
          setTimeout(() => {
            // Make sure we have streams from this peer
            if (peerStreams[peerId]) {
              console.log(
                `[WebRTC] Setting screen share stream state after accepting offer from ${peerId}`
              );
              setPeerStreamsWithData(prev => {
                const newStreamsData = { ...prev };
                newStreamsData[peerId] = {
                  ...newStreamsData[peerId],
                  stream: peerStreams[peerId],
                  isSharing: true,
                  mediaType: 'screen',
                  streamReady: true,
                };
                return newStreamsData;
              });
            }
          }, 1000);
        }
      } catch (error: any) {
        console.error('[WebRTC] Error handling offer:', error);
        setError(`Failed to handle offer: ${error?.message || 'Unknown error'}`);
      } finally {
        processingOffer.current = false;
      }
    },
    [createPeerConnection, getAnswersRef, peerStreams, resetAndRecreateConnection]
  );

  // Handle incoming answer
  const handleAnswer = useCallback((answerData: any, answerId?: string) => {
    const peerId = answerData.from;
    console.log(`[WebRTC] Received answer from ${peerId}`, answerData);

    // Track processed answers similar to how we do with offers
    if (answerId && processedAnswerIds.current.has(answerId)) {
      console.log(`[WebRTC] Skipping already processed answer ${answerId}`);
      return;
    }

    // Add to processed set if we have an ID
    if (answerId) {
      processedAnswerIds.current.add(answerId);
    }

    const pc = peerConnections.current[peerId];
    if (!pc) {
      console.error(`[WebRTC] No connection found for peer ${peerId}`);
      return;
    }

    // Check if the connection is in a state where it can accept an answer
    if (pc.signalingState !== 'have-local-offer') {
      console.warn(
        `[WebRTC] Ignoring answer from ${peerId} - connection not in 'have-local-offer' state (current: ${pc.signalingState})`
      );
      return;
    }

    // Validate the answer data
    if (!answerData.sdp || !answerData.sdp.type || !answerData.sdp.sdp) {
      console.error('[WebRTC] Invalid answer data received:', answerData);
      console.dir(answerData, { depth: null });
      setError(`Invalid answer received from peer ${peerId}`);
      return;
    }

    try {
      // Set the remote description
      pc.setRemoteDescription(new RTCSessionDescription(answerData.sdp))
        .then(() => {
          console.log(`[WebRTC] Set remote description for ${peerId} successfully`);
        })
        .catch(error => {
          console.error(`[WebRTC] Error handling answer:`, error);
          // Don't set error state for expected state errors, just log them
          if (error.name === 'InvalidStateError' || error.message.includes('stable')) {
            console.warn(
              `[WebRTC] Answer arrived when connection was already in stable state, ignoring`
            );
          } else {
            setError(`Failed to handle answer: ${error.message}`);
          }
        });
    } catch (error) {
      console.error('[WebRTC] Error in answer handling:', error);
    }
  }, []);

  // Reset WebRTC state
  const resetState = useCallback(() => {
    // Reset various state variables
    processedOfferIds.current.clear();
    processedAnswerIds.current.clear();
    connectionEstablished.current = false;

    console.log('[WebRTC] Resetting initialization for future reconnection');
    hasInitializedConnection.current = false;
  }, []);

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

  // Define stopSharing function first to avoid circular dependency
  const stopSharing = useCallback(() => {
    // Stop all tracks in the local stream
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => {
        track.stop();
      });

      // Remove tracks from all peer connections
      Object.entries(peerConnections.current).forEach(([peerId, pc]) => {
        if (streamSenders.current[peerId]) {
          streamSenders.current[peerId].forEach(sender => {
            try {
              pc.removeTrack(sender);
            } catch (err) {
              console.warn(`Error removing track from ${peerId}:`, err);
            }
          });
          streamSenders.current[peerId] = [];
        }

        // Send explicit "stopped-sharing" notification to each peer
        console.log(`Sending stopped-sharing notification to ${peerId}`);
        push(getOffersRef(), {
          from: userId.current,
          target: peerId,
          type: 'stopped-sharing',
          timestamp: new Date().toISOString(),
        }).catch(err =>
          console.error(`Error sending stopped-sharing notification to ${peerId}:`, err)
        );
      });

      // Update streaming status in Firebase
      if (roomId != null) {
        const streamingRef = ref(database, `rooms/${roomId}/streaming/${userId.current}`);
        remove(streamingRef).catch(err => {
          console.error('Error removing streaming status:', err);
        });
      }

      // Update local state to reflect stopped sharing
      setPeerStreamsWithData(prev => {
        const newStreamsData = { ...prev };
        if (newStreamsData[userId.current]) {
          newStreamsData[userId.current] = {
            ...newStreamsData[userId.current],
            isSharing: false,
            mediaType: undefined,
          };
        }
        return newStreamsData;
      });

      localStreamRef.current = null;
      setLocalStream(null); // Also update the state
    }
  }, [roomId, getOffersRef]);

  // Share screen
  const shareScreen = useCallback(async (): Promise<MediaStream | null> => {
    try {
      // Check if we're in a conflict scenario where the peer is already sharing
      const peerSharingCount = Object.values(peerStreamsWithData).filter(
        data => data.isSharing
      ).length;

      if (peerSharingCount > 0) {
        console.log('A peer is already sharing their screen. Coordinating sharing transitions...');

        // First notify all peers that we're about to share screen to prevent conflicts
        const peerIds = Object.keys(peerConnections.current);
        const coordinationPromises = [];

        // Create a unique coordination ID for this share attempt
        const coordinationId = `${userId.current}-${Date.now()}`;

        // Create a promise that will resolve when coordination is complete
        const coordinationComplete = new Promise<void>(resolve => {
          // Create a reference to track acknowledgments from peers
          const ackRef = ref(database, `rooms/${roomId}/coordination/${coordinationId}/acks`);

          // Set our intent to share
          set(ref(database, `rooms/${roomId}/coordination/${coordinationId}`), {
            type: 'pre-screen-share',
            from: userId.current,
            timestamp: new Date().toISOString(),
            status: 'pending',
          });

          // Listen for acknowledgments from peers
          const unsubscribe = onValue(ackRef, snapshot => {
            const acks = snapshot.val() || {};
            // Check if all peers have acknowledged
            if (Object.keys(acks).length >= peerIds.length) {
              console.log('All peers have acknowledged our sharing intent');
              unsubscribe();
              // Mark coordination as complete
              set(
                ref(database, `rooms/${roomId}/coordination/${coordinationId}/status`),
                'complete'
              )
                .then(() => resolve())
                .catch(err => {
                  console.error('Error updating coordination status:', err);
                  resolve(); // Resolve anyway to prevent hanging
                });
            }
          });

          // Set a maximum timeout as a fallback (5 seconds)
          setTimeout(() => {
            console.log('Coordination timeout reached, proceeding anyway');
            unsubscribe();
            resolve();
          }, 5000);
        });

        // Notify each peer and collect their acknowledgments
        for (const peerId of peerIds) {
          console.log(`Notifying ${peerId} about upcoming screen share to prevent conflicts`);

          // Send a pre-notification message
          const notifyPromise = push(getOffersRef(), {
            from: userId.current,
            target: peerId,
            type: 'pre-screen-share',
            coordinationId: coordinationId, // Include the coordination ID
            timestamp: new Date().toISOString(),
          }).catch(err => console.error('Error sending pre-notification:', err));

          coordinationPromises.push(notifyPromise);
        }

        // Wait for all notifications to be sent
        await Promise.all(coordinationPromises);

        // Wait for the coordination to complete
        await coordinationComplete;

        console.log('Screen sharing coordination complete, proceeding with connection reset');

        // Close and recreate all peer connections to ensure clean slate
        const peerIds2 = Object.keys(peerConnections.current);
        for (const peerId of peerIds2) {
          const pc = peerConnections.current[peerId];
          if (pc) {
            // Close the current connection to start fresh
            console.log(`Closing connection with ${peerId} to prepare for screen sharing`);
            pc.close();
            delete peerConnections.current[peerId];
          }
        }

        // Wait for connections to be fully closed - use a promise that resolves on next tick
        await new Promise(resolve => setTimeout(resolve, 0));
      }

      // Get screen share media
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
      });

      console.log('Got screen sharing stream with tracks:', stream.getTracks().length);

      // Store it locally and update state
      localStreamRef.current = stream;
      setLocalStream(stream);

      // Update the streaming status in Firebase FIRST
      if (roomId != null) {
        const streamingRef = ref(database, `rooms/${roomId}/streaming/${userId.current}`);
        await set(streamingRef, true).catch(err => {
          console.error('Error setting streaming status:', err);
        });

        // Handle track ended events
        stream.getTracks().forEach(track => {
          track.addEventListener('ended', () => stopSharing());
        });
      }

      // Auto-select the local stream to show in UI
      setSelectedStream(userId.current);

      console.log(
        `Screen sharing - will renegotiate with ${Object.keys(peerConnections.current).length} peers`
      );

      // Update UI to show that we're screen sharing
      setPeerStreamsWithData(prev => {
        const newStreamsData = { ...prev };
        newStreamsData[userId.current] = {
          stream: stream,
          isSharing: true,
          mediaType: 'screen',
          streamReady: true,
        };
        return newStreamsData;
      });

      // Make sure all peers have properly established connections
      // and wait if needed
      const ensureConnections = async () => {
        const peerIds = Object.keys(peerConnections.current);

        if (peerIds.length === 0) {
          console.log('No peers to share screen with');
          return;
        }

        console.log(`Ensuring ${peerIds.length} peer connections are ready for screen sharing`);

        // First, check if we have any peers in "new" state that need connection
        const peersNeedingInitiation = peerIds.filter(peerId => {
          const pc = peerConnections.current[peerId];
          return (
            pc &&
            (pc.connectionState === 'new' || pc.iceConnectionState === 'new') &&
            pc.signalingState === 'stable' // Only if we haven't sent an offer yet
          );
        });

        // Optimize by only recreating connections that need it, and reuse stable ones
        console.log(
          `Found ${peersNeedingInitiation.length} peers needing initialization out of ${peerIds.length} total peers`
        );

        // First handle peers needing initialization
        for (const peerId of peersNeedingInitiation) {
          try {
            const existingPc = peerConnections.current[peerId];
            if (existingPc) {
              console.log(`Closing connection with ${peerId} that needs initialization`);
              existingPc.close();
              delete peerConnections.current[peerId];
            }

            // Create a new peer connection with screens
            console.log(`Creating fresh connection with ${peerId} for screen sharing`);
            const shouldInitiate = userId.current > peerId;
            createPeerConnection(peerId, shouldInitiate);
          } catch (err) {
            console.error(`Error creating fresh connection with ${peerId}:`, err);
          }
        }

        // For peers with established connections, check if they're in a good state
        const stablePeers = peerIds.filter(peerId => !peersNeedingInitiation.includes(peerId));
        console.log(`${stablePeers.length} peers have established connections`);

        for (const peerId of stablePeers) {
          const pc = peerConnections.current[peerId];
          if (!pc) continue;

          // Only recreate if connection is in a problematic state
          if (
            pc.connectionState === 'failed' ||
            pc.connectionState === 'disconnected' ||
            pc.iceConnectionState === 'failed' ||
            pc.signalingState === 'have-local-offer' // Could cause conflicts with new offers
          ) {
            try {
              console.log(
                `Recreating problematic connection with ${peerId} (${pc.connectionState}/${pc.iceConnectionState}/${pc.signalingState})`
              );
              pc.close();
              delete peerConnections.current[peerId];

              // Create a new peer connection
              const shouldInitiate = userId.current > peerId;
              createPeerConnection(peerId, shouldInitiate);
            } catch (err) {
              console.error(`Error recreating problematic connection with ${peerId}:`, err);
            }
          } else {
            console.log(
              `Reusing stable connection with ${peerId} (${pc.connectionState}/${pc.iceConnectionState}/${pc.signalingState})`
            );
          }
        }

        // Wait for connections to initialize using connection events instead of arbitrary timeout
        console.log('Waiting for connections to initialize...');

        // Create a promise that resolves when connections are ready or max time is reached
        await Promise.all(
          peerIds.map(peerId => {
            const pc = peerConnections.current[peerId];
            if (!pc) return Promise.resolve(); // Skip if no connection

            return new Promise<void>(resolve => {
              // If already in good state, resolve immediately
              if (
                pc.connectionState === 'connected' ||
                pc.iceConnectionState === 'connected' ||
                pc.iceConnectionState === 'completed'
              ) {
                console.log(`Connection with ${peerId} already in good state, ready for offers`);
                resolve();
                return;
              }

              // Set up event listeners for connection state changes
              const connectionStateHandler = () => {
                if (
                  pc.connectionState === 'connected' ||
                  pc.iceConnectionState === 'connected' ||
                  pc.iceConnectionState === 'completed'
                ) {
                  console.log(`Connection with ${peerId} now in good state, ready for offers`);
                  cleanup();
                  resolve();
                }
              };

              const iceConnectionStateHandler = () => {
                if (
                  pc.iceConnectionState === 'connected' ||
                  pc.iceConnectionState === 'completed'
                ) {
                  console.log(`ICE connection with ${peerId} now in good state, ready for offers`);
                  cleanup();
                  resolve();
                }
              };

              // Clean up event listeners
              const cleanup = () => {
                pc.removeEventListener('connectionstatechange', connectionStateHandler);
                pc.removeEventListener('iceconnectionstatechange', iceConnectionStateHandler);
              };

              // Add event listeners
              pc.addEventListener('connectionstatechange', connectionStateHandler);
              pc.addEventListener('iceconnectionstatechange', iceConnectionStateHandler);

              // Set a maximum timeout as fallback (5 seconds)
              setTimeout(() => {
                console.log(`Timeout reached for connection with ${peerId}, proceeding anyway`);
                cleanup();
                resolve();
              }, 5000);
            });
          })
        );

        // Now ensure all connections that need it have offers sent
        for (const peerId of peerIds) {
          const pc = peerConnections.current[peerId];
          if (!pc) continue;

          const shouldInitiate = userId.current > peerId;
          if (shouldInitiate && pc.signalingState === 'stable') {
            try {
              console.log(`Creating special pre-sharing offer for ${peerId}`);

              pc.createOffer()
                .then(offer => pc.setLocalDescription(offer))
                .then(() => {
                  if (!pc.localDescription) return;

                  console.log(`Sending pre-sharing offer to ${peerId}`);
                  return push(getOffersRef(), {
                    from: userId.current,
                    target: peerId,
                    sdp: {
                      type: pc.localDescription.type,
                      sdp: pc.localDescription.sdp,
                    },
                    timestamp: new Date().toISOString(),
                  });
                })
                .catch(err => console.error(`Error sending pre-sharing offer to ${peerId}:`, err));
            } catch (err) {
              console.error(`Failed to create pre-sharing offer for ${peerId}:`, err);
            }
          }
        }

        // Wait for ICE gathering to complete using events instead of arbitrary timeout
        console.log('Waiting for ICE gathering to complete before sharing screen...');

        // Monitor ICE gathering state of all connections
        await Promise.all(
          peerIds.map(peerId => {
            const pc = peerConnections.current[peerId];
            if (!pc) return Promise.resolve(); // Skip if no connection

            return new Promise<void>(resolve => {
              // If already complete, resolve immediately
              if (pc.iceGatheringState === 'complete') {
                console.log(`ICE gathering for ${peerId} already complete`);
                resolve();
                return;
              }

              // Set up event listener for ICE gathering state changes
              const iceGatheringStateHandler = () => {
                if (pc.iceGatheringState === 'complete') {
                  console.log(`ICE gathering for ${peerId} now complete`);
                  pc.removeEventListener('icegatheringstatechange', iceGatheringStateHandler);
                  resolve();
                }
              };

              // Add event listener
              pc.addEventListener('icegatheringstatechange', iceGatheringStateHandler);

              // Set a maximum timeout as fallback (3 seconds)
              setTimeout(() => {
                console.log(`ICE gathering timeout reached for ${peerId}, proceeding anyway`);
                pc.removeEventListener('icegatheringstatechange', iceGatheringStateHandler);
                resolve();
              }, 3000);
            });
          })
        );

        console.log(
          `Connection setup complete: ${peersNeedingInitiation.length} peers recreated, ${stablePeers.length} stable peers reused`
        );
      };

      // Wait for connections to be ready
      await ensureConnections();

      // Create a function to add tracks to a peer connection
      const addTracksToConnection = async (
        peerId: string,
        pc: RTCPeerConnection
      ): Promise<boolean> => {
        try {
          // Check connection state more permissively - attempt to add tracks in more states
          const canAddTracks =
            pc.signalingState === 'stable' ||
            pc.connectionState === 'connecting' ||
            pc.connectionState === 'connected' ||
            pc.iceConnectionState === 'checking' ||
            pc.iceConnectionState === 'connected';

          if (!canAddTracks) {
            console.log(
              `Connection with ${peerId} not ready (${pc.connectionState}/${pc.iceConnectionState}/${pc.signalingState}), waiting...`
            );
            // Wait for connection to establish
            return false;
          }

          console.log(
            `Adding screen share tracks to connection with ${peerId} (${pc.connectionState}/${pc.iceConnectionState}/${pc.signalingState})`
          );

          // First clean up any existing senders to avoid duplicates
          if (streamSenders.current[peerId]) {
            for (const sender of streamSenders.current[peerId]) {
              try {
                pc.removeTrack(sender);
              } catch (e) {
                console.warn(`Error removing existing track: ${e}`);
              }
            }
            streamSenders.current[peerId] = [];
          }

          // Add all tracks from the stream
          const senders: RTCRtpSender[] = [];
          stream.getTracks().forEach(track => {
            try {
              console.log(`Adding ${track.kind} track to connection with ${peerId}`);
              const sender = pc.addTrack(track, stream);
              senders.push(sender);
            } catch (err) {
              console.error(`Failed to add ${track.kind} track to connection with ${peerId}:`, err);
            }
          });

          if (senders.length === 0) {
            console.error(`No track senders created for ${peerId}`);
            return false;
          }

          // Update senders
          if (!streamSenders.current[peerId]) {
            streamSenders.current[peerId] = [];
          }
          streamSenders.current[peerId].push(...senders);

          // Wait a moment to ensure tracks are properly added
          await new Promise(resolve => setTimeout(resolve, 200));

          // Create a new offer to notify peer about the added tracks
          try {
            console.log(`Creating offer with screen tracks for ${peerId}`);
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);

            if (!pc.localDescription) {
              throw new Error('No local description to send');
            }

            console.log(`Sending screen share update offer to ${peerId}`);

            // Send the offer with a special flag
            await push(getOffersRef(), {
              from: userId.current,
              target: peerId,
              sdp: {
                type: pc.localDescription.type,
                sdp: pc.localDescription.sdp,
              },
              hasScreen: true, // This flag tells the recipient this is a screen share
              timestamp: new Date().toISOString(),
            });

            console.log(`Screen share successfully added to connection with ${peerId}`);
            return true;
          } catch (err) {
            console.error(`Error creating or sending offer after adding tracks to ${peerId}:`, err);
            return false;
          }
        } catch (err) {
          console.error(`Error adding screen share to connection with ${peerId}:`, err);
          return false;
        }
      };

      // Process all peer connections with a retry mechanism
      const peerIds = Object.keys(peerConnections.current);
      console.log(`Starting screen share negotiations with ${peerIds.length} peers`);

      // Process connections in parallel with retries
      const retryInterval = 1000; // 1 second between retries
      const maxRetries = 5;

      const processConnection = async (peerId: string) => {
        const pc = peerConnections.current[peerId];
        if (!pc) return;

        let success = false;
        let attempts = 0;

        while (!success && attempts < maxRetries) {
          success = await addTracksToConnection(peerId, pc);
          if (!success) {
            console.log(`Retry ${attempts + 1}/${maxRetries} for ${peerId} in ${retryInterval}ms`);
            await new Promise(resolve => setTimeout(resolve, retryInterval));
            attempts++;
          }
        }

        if (!success) {
          console.warn(`Failed to add screen share to ${peerId} after ${maxRetries} attempts`);
          // Create a new connection as a last resort
          console.log(`Creating new connection with ${peerId} for screen sharing`);
          const shouldInitiate = userId.current > peerId;
          const newPc = createPeerConnection(peerId, shouldInitiate);
          if (newPc) {
            // The tracks will be added by the createPeerConnection function
          }
        }
      };

      // Start the connection processing
      await Promise.all(peerIds.map(processConnection));

      return stream;
    } catch (error) {
      console.error('Error getting screen share:', error);
      setError(`Failed to get screen: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }, [getOffersRef, roomId, stopSharing, createPeerConnection]);

  // Select stream
  const selectStream = useCallback((streamId: string | null) => {
    setSelectedStream(streamId);
  }, []);

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
