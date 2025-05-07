import { onValue, push, ref, remove, set } from 'firebase/database';
import React, { useCallback } from 'react';
import { database } from '../firebase';
import { PeerConnections, PeerStreamData, StreamSenders } from './types/webRTC';
import { useFirebaseRefs } from './useFirebaseRefs';

interface UseMediaStreamsProps {
  roomId: string;
  userId: React.MutableRefObject<string>;
  peerStreamsWithData: Record<string, PeerStreamData>;
  peerConnections: React.MutableRefObject<PeerConnections>;
  localStreamRef: React.MutableRefObject<MediaStream | null>;
  setLocalStream: React.Dispatch<React.SetStateAction<MediaStream | null>>;
  setSelectedStream: React.Dispatch<React.SetStateAction<string | null>>;
  setPeerStreamsWithData: React.Dispatch<React.SetStateAction<Record<string, PeerStreamData>>>;
  createPeerConnection: (peerId: string, isInitiator: boolean) => RTCPeerConnection | null;
  streamSenders: React.MutableRefObject<StreamSenders>;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
}
interface UseMediaStreamsResult {
  stopSharing: () => void;
  shareScreen: () => Promise<MediaStream | null>;
  selectStream: (streamId: string | null) => void;
}

export function useMediaStreams({
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
}: UseMediaStreamsProps): UseMediaStreamsResult {
  // Get Firebase references
  const { getOffersRef } = useFirebaseRefs(roomId, userId.current);

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

  return { stopSharing, shareScreen, selectStream };
}
