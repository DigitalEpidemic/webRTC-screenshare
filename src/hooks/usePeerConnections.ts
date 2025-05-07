import { get, push, ref, remove } from 'firebase/database';
import React, { useCallback } from 'react';
import { database } from '../firebase';
import { PeerStreamData, StreamSenders } from './types/webRTC';
import { useFirebaseRefs } from './useFirebaseRefs';

interface UsePeerConnectionsProps {
  roomId: string;
  userId: React.MutableRefObject<string>;
  peerConnections: React.MutableRefObject<Record<string, RTCPeerConnection>>;
  localStreamRef: React.MutableRefObject<MediaStream | null>;
  streamSenders: React.MutableRefObject<StreamSenders>;
  setPeerStreams: React.Dispatch<React.SetStateAction<Record<string, MediaStream>>>;
  peers: string[];
  setPeers: React.Dispatch<React.SetStateAction<string[]>>;
  setPeerStreamsWithData: React.Dispatch<React.SetStateAction<Record<string, PeerStreamData>>>;
  selectedStream: string | null;
  setSelectedStream: React.Dispatch<React.SetStateAction<string | null>>;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
}

interface UsePeerConnectionsResult {
  createPeerConnection: (peerId: string, isInitiator: boolean) => RTCPeerConnection | null;
  resetAndRecreateConnection: (
    peerId: string,
    shouldInitiate?: boolean
  ) => RTCPeerConnection | null;
  handleIceCandidate: (candidateData: any) => void;
  handlePeerLeft: (peerId: string) => void;
}

export function usePeerConnections({
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
}: UsePeerConnectionsProps): UsePeerConnectionsResult {
  // Get Firebase references
  const { getOffersRef, getCandidatesRef } = useFirebaseRefs(roomId, userId.current);

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

  return { createPeerConnection, resetAndRecreateConnection, handleIceCandidate, handlePeerLeft };
}
