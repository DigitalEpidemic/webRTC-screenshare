import { onValue, push, ref, set } from 'firebase/database';
import React, { useCallback } from 'react';
import { database } from '../firebase';
import { PeerConnections, PeerStreamData } from './types/webRTC';
import { useFirebaseRefs } from './useFirebaseRefs';

interface UseOfferAnswerProps {
  roomId: string;
  userId: React.MutableRefObject<string>;
  processedOfferIds: React.MutableRefObject<Set<string>>;
  processingOffer: React.MutableRefObject<boolean>;
  localStreamRef: React.MutableRefObject<MediaStream | null>;
  peerConnections: React.MutableRefObject<PeerConnections>;
  createPeerConnection: (peerId: string, isInitiator: boolean) => RTCPeerConnection | null;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
  setPeerStreamsWithData: React.Dispatch<React.SetStateAction<Record<string, PeerStreamData>>>;
  resetAndRecreateConnection: (
    peerId: string,
    shouldInitiate?: boolean
  ) => RTCPeerConnection | null;
  streamSenders: React.MutableRefObject<{ [peerId: string]: RTCRtpSender[] }>;
  selectedStream: string | null;
  peerStreamsWithData: Record<string, PeerStreamData>;
  selectStream: React.Dispatch<React.SetStateAction<string | null>>;
  peerStreams: Record<string, MediaStream>;
  processedAnswerIds: React.MutableRefObject<Set<string>>;
}

interface UseOfferAnswerResult {
  handleOffer: (offerData: any, offerId?: string) => void;
  handleAnswer: (answerData: any, answerId?: string) => void;
}

export function useOfferAnswer({
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
  selectStream,
  peerStreams,
  processedAnswerIds,
}: UseOfferAnswerProps): UseOfferAnswerResult {
  // Get Firebase references
  const { getOffersRef, getAnswersRef } = useFirebaseRefs(roomId, userId.current);

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

  return { handleOffer, handleAnswer };
}
