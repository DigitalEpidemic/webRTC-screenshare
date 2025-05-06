import { get, onChildAdded, onValue, push, ref, remove, set } from 'firebase/database';
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

  // Create a peer connection
  const createPeerConnection = useCallback(
    (peerId: string, isInitiator: boolean): RTCPeerConnection | null => {
      try {
        // Check if the peer is already connecting or connected
        const existingPc = peerConnections.current[peerId];
        if (existingPc) {
          // Only close if in a failed or closed state
          if (
            existingPc.connectionState === 'failed' ||
            existingPc.connectionState === 'closed' ||
            existingPc.iceConnectionState === 'failed'
          ) {
            console.log(
              `Closing existing connection with ${peerId} in state: ${existingPc.connectionState}`
            );
            existingPc.close();
            delete peerConnections.current[peerId];
          } else {
            console.log(
              `Reusing existing connection with ${peerId} in state: ${existingPc.connectionState}`
            );
            return existingPc;
          }
        }

        console.log(`Creating new RTCPeerConnection with ${peerId}`);

        const pc = new RTCPeerConnection({
          iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
          ],
        });

        // Store the connection before adding any handlers to prevent race conditions
        peerConnections.current[peerId] = pc;

        // Add local tracks if we're already sharing
        if (localStreamRef.current) {
          console.log(
            `Adding ${localStreamRef.current.getTracks().length} local tracks to new connection with ${peerId}`
          );

          try {
            // Clean up any existing senders first
            if (streamSenders.current[peerId]) {
              streamSenders.current[peerId] = [];
            } else {
              streamSenders.current[peerId] = [];
            }

            // Add all tracks
            localStreamRef.current.getTracks().forEach(track => {
              console.log(`Adding ${track.kind} track to connection with ${peerId}`);
              try {
                // Wait until the connection is fully created before adding tracks
                setTimeout(() => {
                  try {
                    if (peerConnections.current[peerId] === pc) {
                      const sender = pc.addTrack(track, localStreamRef.current!);
                      streamSenders.current[peerId].push(sender);
                      console.log(
                        `Successfully added delayed ${track.kind} track to connection with ${peerId}`
                      );

                      // Renegotiate if needed
                      if (pc.signalingState === 'stable' && isInitiator) {
                        setTimeout(() => {
                          console.log(
                            `Creating renegotiation offer for ${peerId} after adding tracks`
                          );
                          pc.createOffer()
                            .then(offer => pc.setLocalDescription(offer))
                            .then(() => {
                              if (!pc.localDescription) return;

                              console.log(`Sending renegotiation offer to ${peerId}`);
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
                              console.error(`Error sending renegotiation offer to ${peerId}:`, err)
                            );
                        }, 1000);
                      }
                    }
                  } catch (err) {
                    console.error(`Delayed track add failed for ${peerId}:`, err);
                  }
                }, 1000); // 1 second delay to let the connection establish first
              } catch (err) {
                console.error(`Failed to add ${track.kind} track to connection:`, err);
              }
            });
          } catch (err) {
            console.error(`Error adding tracks to new connection with ${peerId}:`, err);
          }
        } else {
          console.log(`No local stream to add to connection with ${peerId}`);
        }

        // Handle ICE candidates
        pc.onicecandidate = event => {
          if (event.candidate) {
            console.log(`Sending ICE candidate to ${peerId}`);
            push(getCandidatesRef(), {
              from: userId.current,
              target: peerId,
              candidate: event.candidate,
              timestamp: new Date().toISOString(),
            }).catch(err => {
              console.error(`Error sending ICE candidate to ${peerId}:`, err);
            });
          }
        };

        pc.oniceconnectionstatechange = () => {
          console.log(`ICE connection state with ${peerId}: ${pc.iceConnectionState}`);

          if (pc.iceConnectionState === 'failed') {
            console.log(`ICE connection failed with ${peerId}, attempting restart`);
            pc.restartIce();
          } else if (
            pc.iceConnectionState === 'connected' ||
            pc.iceConnectionState === 'completed'
          ) {
            console.log(`ICE connection established with ${peerId}`);
          }
        };

        pc.onconnectionstatechange = () => {
          console.log(`Connection state with ${peerId}: ${pc.connectionState}`);

          if (
            pc.connectionState === 'disconnected' ||
            pc.connectionState === 'failed' ||
            pc.connectionState === 'closed'
          ) {
            console.log(`Connection with ${peerId} lost or failed (${pc.connectionState})`);

            // Clean up
            if (streamSenders.current[peerId]) {
              streamSenders.current[peerId] = [];
            }

            // Remove stream if connection failed
            if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
              setPeerStreams(prev => {
                const newStreams = { ...prev };
                delete newStreams[peerId];
                return newStreams;
              });

              // Retry connection after a delay if the peer is still in the room
              if (peers.includes(peerId)) {
                console.log(`Peer ${peerId} is still in the room, will retry connection soon`);
                setTimeout(() => {
                  // Only recreate if it's still the same failed connection
                  if (peerConnections.current[peerId] === pc) {
                    console.log(`Retrying connection with ${peerId}`);
                    const shouldInitiate = userId.current > peerId;
                    createPeerConnection(peerId, shouldInitiate);
                  }
                }, 2000); // Wait 2 seconds before retry
              }
            }
          } else if (pc.connectionState === 'connected') {
            console.log(`Connection established with ${peerId}`);
          }
        };

        pc.onsignalingstatechange = () => {
          console.log(`Signaling state with ${peerId}: ${pc.signalingState}`);
        };

        // Handle incoming tracks
        pc.ontrack = event => {
          console.log(`Received ${event.track.kind} track from ${peerId}`);

          if (event.streams && event.streams.length > 0) {
            const stream = event.streams[0];
            console.log(`Stream has ${stream.getTracks().length} tracks`);

            // Always store the stream regardless of video tracks - audio-only is also valid
            setPeerStreams(prev => ({
              ...prev,
              [peerId]: stream,
            }));

            // Check for screen sharing status from Firebase
            const peerScreenShareStatus = ref(database, `rooms/${roomId}/streaming/${peerId}`);
            get(peerScreenShareStatus)
              .then(snapshot => {
                const isScreenSharing = snapshot.val() === true;
                console.log(
                  `Peer ${peerId} screen sharing status:`,
                  isScreenSharing ? 'sharing' : 'not sharing'
                );

                // Update with stream data and screen sharing status
                setPeerStreamsWithData(prev => {
                  return {
                    ...prev,
                    [peerId]: {
                      ...prev[peerId],
                      stream,
                      isSharing: isScreenSharing,
                      mediaType: isScreenSharing ? 'screen' : 'camera',
                      streamReady: true, // Mark stream as ready to play
                    },
                  };
                });

                // Also auto-select the screen share if available
                if (isScreenSharing && !selectedStream) {
                  console.log(`Auto-selecting screen share from ${peerId}`);
                  setSelectedStream(peerId);
                }

                // Verify stream is properly initialized
                if (isScreenSharing) {
                  // Wait a short time then make sure streamReady is properly set
                  setTimeout(() => {
                    console.log(`Verifying stream readiness for ${peerId}`);
                    setPeerStreamsWithData(prev => {
                      // Only update if still sharing
                      if (prev[peerId]?.isSharing) {
                        return {
                          ...prev,
                          [peerId]: {
                            ...prev[peerId],
                            streamReady: true,
                          },
                        };
                      }
                      return prev;
                    });
                  }, 1000);
                }
              })
              .catch(err => {
                console.error(`Error getting screen sharing status for ${peerId}:`, err);

                // Fall back to updating without screen share info
                setPeerStreamsWithData(prev => ({
                  ...prev,
                  [peerId]: {
                    ...prev[peerId],
                    stream,
                    isSharing: false,
                    mediaType: 'camera', // Default assumption
                    streamReady: true, // Mark as ready anyway
                  },
                }));

                // Auto-select this stream if nothing is selected
                if (!selectedStream) {
                  setSelectedStream(peerId);
                }
              });
          }
        };

        // Create and send offer if initiator with proper error handling
        if (isInitiator) {
          console.log(`Creating offer for ${peerId}`);

          // Create a helper function to send the offer
          const sendOffer = () => {
            // Check that connection is still valid before proceeding
            if (
              !peerConnections.current[peerId] ||
              peerConnections.current[peerId] !== pc ||
              pc.signalingState === 'closed'
            ) {
              console.warn(`Connection with ${peerId} is no longer valid, not sending offer`);
              return;
            }

            try {
              pc.createOffer()
                .then(offer => {
                  // Double-check connection is still valid
                  if (pc.signalingState === 'closed') {
                    throw new Error('Connection closed before setting local description');
                  }

                  console.log(`Setting local description for ${peerId}`);
                  return pc.setLocalDescription(offer);
                })
                .then(() => {
                  // Make sure we have a valid local description before sending
                  if (!pc.localDescription) {
                    throw new Error('No local description to send');
                  }

                  // Check connection state again before sending
                  if (pc.signalingState === 'closed') {
                    throw new Error('Connection closed before sending offer');
                  }

                  console.log(`Sending offer to ${peerId}:`, pc.localDescription.type);
                  const sdpData = {
                    type: pc.localDescription.type,
                    sdp: pc.localDescription.sdp,
                  };

                  return push(getOffersRef(), {
                    from: userId.current,
                    target: peerId,
                    sdp: sdpData,
                    timestamp: new Date().toISOString(),
                  });
                })
                .catch(error => {
                  if (error.name === 'InvalidStateError' || error.message.includes('closed')) {
                    console.warn(
                      `Failed to create offer due to connection state: ${error.message}`
                    );
                  } else {
                    console.error('Error creating offer:', error);
                    setError(`Failed to create offer: ${error.message}`);
                  }
                });
            } catch (error) {
              console.error(`Unexpected error creating offer: ${error}`);
            }
          };

          // Wait a short period to ensure both peers are ready, with progressive backoff
          setTimeout(sendOffer, 1000);
        }

        return pc;
      } catch (error) {
        console.error('Error creating peer connection:', error);
        setError(
          `Failed to create peer connection: ${error instanceof Error ? error.message : String(error)}`
        );
        return null;
      }
    },
    [getCandidatesRef, getOffersRef, peers]
  );

  // Add a helper function to handle connection resets
  const resetAndRecreateConnection = useCallback(
    (peerId: string, shouldInitiate: boolean = false): RTCPeerConnection | null => {
      console.log(`[WebRTC] Resetting and recreating connection with ${peerId}`);

      try {
        // Close existing connection if it exists
        const existingPc = peerConnections.current[peerId];
        if (existingPc) {
          console.log(
            `[WebRTC] Closing existing connection in state: ${existingPc.connectionState}`
          );
          existingPc.close();
          delete peerConnections.current[peerId];
        }

        // Clean up senders
        if (streamSenders.current[peerId]) {
          delete streamSenders.current[peerId];
        }

        // Create a new connection
        const newPc = createPeerConnection(peerId, shouldInitiate);
        return newPc;
      } catch (error) {
        console.error(`[WebRTC] Error resetting connection with ${peerId}:`, error);
        return null;
      }
    },
    [createPeerConnection]
  );

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

  // Handle incoming ICE candidate
  const handleIceCandidate = useCallback((candidateData: any) => {
    const peerId = candidateData.from;

    if (peerConnections.current[peerId] && candidateData.candidate) {
      const pc = peerConnections.current[peerId];

      pc.addIceCandidate(new RTCIceCandidate(candidateData.candidate)).catch(error => {
        console.error(`[WebRTC] Error adding ICE candidate from ${peerId}:`, error);
      });
    }
  }, []);

  // Handle peer leaving
  const handlePeerLeft = useCallback(
    (peerId: string) => {
      console.log(`[WebRTC] Peer left: ${peerId}`);

      // Close and remove the connection
      if (peerConnections.current[peerId]) {
        console.log(`[WebRTC] Closing connection with peer: ${peerId}`);
        try {
          peerConnections.current[peerId].close();
        } catch (err) {
          console.error(`[WebRTC] Error closing connection with ${peerId}:`, err);
        }
        delete peerConnections.current[peerId];
      }

      // Remove from UI
      setPeerStreams(prev => {
        const newStreams = { ...prev };
        if (peerId in newStreams) {
          console.log(`[WebRTC] Removing stream for peer: ${peerId}`);
          delete newStreams[peerId];
        }
        return newStreams;
      });

      // Clean up senders
      if (streamSenders.current[peerId]) {
        console.log(`[WebRTC] Cleaning up stream senders for peer: ${peerId}`);
        delete streamSenders.current[peerId];
      }

      // Update peers list
      setPeers(prev => {
        const newPeers = prev.filter(id => id !== peerId);
        console.log(`[WebRTC] Updated peers list after ${peerId} left:`, newPeers);
        return newPeers;
      });

      // Reset selected stream if needed
      setSelectedStream(prev => {
        if (prev === peerId) {
          console.log(`[WebRTC] Resetting selected stream from left peer: ${peerId}`);
          return null;
        }
        return prev;
      });

      // IMPORTANT FIX: Clean up any streaming status for this peer
      // This ensures the UI's active streamers count is updated correctly
      setPeerStreamsWithData(prev => {
        const newStreamsData = { ...prev };
        if (peerId in newStreamsData) {
          console.log(`[WebRTC] Cleaning up streaming data for left peer: ${peerId}`);

          // Set isSharing to false to ensure proper UI updates
          newStreamsData[peerId] = {
            ...newStreamsData[peerId],
            isSharing: false,
            streamReady: false,
            mediaType: undefined,
          };
        }
        return newStreamsData;
      });

      // Also clean up any streaming status in Firebase
      if (roomId) {
        const streamingRef = ref(database, `rooms/${roomId}/streaming/${peerId}`);
        remove(streamingRef).catch(err => {
          console.error(`[WebRTC] Error cleaning streaming status for left peer ${peerId}:`, err);
        });
      }
    },
    [roomId]
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
    if (currentRoomId.current != null) {
      console.log(`[WebRTC] Removing user ${userId.current} from room ${currentRoomId.current}`);
      const userRef = ref(database, `rooms/${currentRoomId.current}/users/${userId.current}`);

      // Also clean up any streaming status
      const streamingRef = ref(
        database,
        `rooms/${currentRoomId.current}/streaming/${userId.current}`
      );

      // Clean up any coordination data this user initiated
      const coordinationQuery = ref(database, `rooms/${currentRoomId.current}/coordination`);
      get(coordinationQuery)
        .then(snapshot => {
          if (snapshot.exists()) {
            const coordinationData = snapshot.val();
            // Find and clean up any coordination data initiated by this user
            const promises: Promise<void>[] = [];

            Object.keys(coordinationData).forEach(coordId => {
              if (coordId.startsWith(`${userId.current}-`)) {
                console.log(`[WebRTC] Cleaning up coordination data: ${coordId}`);
                const coordRef = ref(
                  database,
                  `rooms/${currentRoomId.current}/coordination/${coordId}`
                );
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
          const roomUsersRef = ref(database, `rooms/${currentRoomId.current}/users`);
          return get(roomUsersRef);
        })
        .then(snapshot => {
          if (snapshot.exists()) {
            const users = snapshot.val();
            if (Object.keys(users).length === 0) {
              // Room is empty, remove it entirely
              console.log(`[WebRTC] Room ${currentRoomId.current} is now empty, removing it`);
              const roomRef = ref(database, `rooms/${currentRoomId.current}`);
              return remove(roomRef);
            }
          }
        })
        .catch(err => {
          console.error('[WebRTC] Error removing user or checking room status:', err);
        });
    }
  }, []);

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

  // Reset WebRTC state
  const resetState = useCallback(() => {
    // Reset various state variables
    processedOfferIds.current.clear();
    processedAnswerIds.current.clear();
    connectionEstablished.current = false;

    console.log('[WebRTC] Resetting initialization for future reconnection');
    hasInitializedConnection.current = false;
  }, []);

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
      if (currentRoomId.current) {
        markUserAsInactive();
      }
    };
  }, [disconnectFromRoom, markUserAsInactive]);

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
