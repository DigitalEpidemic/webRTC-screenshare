import { ArrowLeft, Copy, Monitor, RefreshCw, Users, X } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useWebRTCFirebase } from '../hooks/useWebRTCFirebase';

interface RoomProps {
  roomId: string;
  onLeaveRoom: () => void;
}

export function Room({ roomId, onLeaveRoom }: RoomProps): React.ReactElement {
  const [copied, setCopied] = useState<boolean>(false);
  const [showParticipants, setShowParticipants] = useState<boolean>(false);
  const [isSharingScreen, setIsSharingScreen] = useState<boolean>(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState<string | null>(null);

  const {
    isConnected,
    isConnecting,
    isLoading,
    peers,
    localStream,
    peerStreams,
    peerStreamsWithData,
    selectedStream,
    selectStream,
    shareScreen,
    stopSharing,
    userId,
    requestStream,
  } = useWebRTCFirebase({ roomId });

  // Stabilize refs to avoid re-renders
  const roomIdRef = useRef(roomId);
  const rendersRef = useRef(0);

  // Track renders for debugging
  useEffect(() => {
    rendersRef.current += 1;
    console.log(`[Room] Render count: ${rendersRef.current}`);
  });

  // Update the roomId ref when it changes
  useEffect(() => {
    roomIdRef.current = roomId;
  }, [roomId]);

  // Cleanup effect - ensure all media is properly stopped when component unmounts
  useEffect(() => {
    return () => {
      console.log('Room component unmounting - cleaning up media resources');
      if (localStream) {
        // Stop all tracks
        localStream.getTracks().forEach(track => {
          console.log(`Stopping track: ${track.kind} (${track.id})`);
          track.stop();
        });

        // Update sharing state
        setIsSharingScreen(false);

        // Use the WebRTC hook's stopSharing function for additional cleanup
        stopSharing();
      }

      // Ensure video element's srcObject is cleared
      if (videoRef.current && videoRef.current.srcObject) {
        const mediaStream = videoRef.current.srcObject as MediaStream;
        if (mediaStream) {
          // Stop all tracks in the video element
          mediaStream.getTracks().forEach(track => {
            console.log(`Stopping video element track: ${track.kind} (${track.id})`);
            track.stop();
          });
        }
        videoRef.current.srcObject = null;
      }

      // Safeguard: directly access display media API to ensure any screen sharing is stopped
      // This is a belt-and-suspenders approach to ensure screen sharing is truly stopped
      if (navigator.mediaDevices && typeof navigator.mediaDevices.getDisplayMedia === 'function') {
        console.log('Ensuring all screen sharing is properly stopped');
      }
    };
  }, [localStream, stopSharing]);

  // Ref to store active streams data for logging without causing re-renders
  const activeStreamsRef = useRef({
    localStream: 'no',
    peerStreams: [] as string[],
    peerStreamsWithData: [] as any[],
    selected: null as string | null,
  });

  // Log stream changes without causing re-renders
  useEffect(() => {
    activeStreamsRef.current = {
      localStream: localStream ? 'yes' : 'no',
      peerStreams: Object.keys(peerStreams),
      peerStreamsWithData: Object.entries(peerStreamsWithData).map(([key, data]) => ({
        id: key,
        isSharing: data.isSharing,
        mediaType: data.mediaType,
        streamReady: data.streamReady,
      })),
      selected: selectedStream,
    };

    console.log('Active streams:', activeStreamsRef.current);
  }, [localStream, peerStreams, peerStreamsWithData, selectedStream]);

  // Track participants for debugging
  useEffect(() => {
    console.log(
      'All participants:',
      peers.map(peerId => ({ id: peerId }))
    );
  }, [peers]);

  // Set the video stream
  useEffect(() => {
    if (!videoRef.current) return;

    let streamToShow: MediaStream | null = null;

    // Determine which stream to show
    if (selectedStream) {
      // If selected stream is our own
      if (selectedStream === userId && localStream) {
        streamToShow = localStream;
      }
      // If selected stream is from a peer
      else if (selectedStream in peerStreams && peerStreams[selectedStream]) {
        streamToShow = peerStreams[selectedStream];
      }
    }
    // Default: show our own stream if no selection
    else if (localStream) {
      streamToShow = localStream;
    }

    if (streamToShow) {
      // First update srcObject property
      if (videoRef.current.srcObject !== streamToShow) {
        videoRef.current.srcObject = streamToShow;

        // Force play the video to ensure it starts
        videoRef.current.play().catch(err => {
          console.warn('Error auto-playing video:', err);
        });
      }
    } else {
      videoRef.current.srcObject = null;
    }
  }, [selectedStream, localStream, peerStreams, userId]);

  // Handle sharing screen
  const handleShareScreen = useCallback(async () => {
    if (isSharingScreen) {
      await stopSharing();
      setIsSharingScreen(false);
    } else {
      const stream = await shareScreen();
      if (stream) {
        setIsSharingScreen(true);
      }
    }
  }, [isSharingScreen, shareScreen, stopSharing]);

  // Handle stopping screen share
  const handleStopSharing = useCallback(() => {
    // Stop sharing through WebRTC hook
    stopSharing();
    setIsSharingScreen(false);

    // Clear selected stream if it was our own
    if (selectedStream === userId) {
      selectStream(null);

      // Find other sharing peer to display
      const sharingPeer = Object.entries(peerStreamsWithData).find(
        ([id, data]) => id !== userId && data?.isSharing && data?.streamReady
      )?.[0];

      if (sharingPeer) {
        console.log(
          'Switching view to another sharing peer after stopping our share:',
          sharingPeer
        );
        selectStream(sharingPeer);
      }
    }

    // We no longer need this - the WebRTC hook sends a dedicated "stopped-sharing" signal
    // to all peers, which will update their UI automatically
  }, [stopSharing, userId, selectedStream, selectStream, peerStreamsWithData]);

  // Copy room link to clipboard
  const copyRoomLink = useCallback((): void => {
    const url = `${window.location.origin}/room/${roomId}`;
    navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [roomId]);

  // Find active streamers (peers with streams + local user if sharing)
  const activeStreamers = (() => {
    // Get sharing peers (excluding self)
    const sharingPeers = Object.keys(peerStreamsWithData).filter(
      id =>
        id !== userId && // Exclude local user from this count
        peerStreamsWithData[id]?.isSharing === true &&
        peerStreamsWithData[id]?.streamReady === true
    );

    // Add local user if sharing
    return [...sharingPeers, ...(localStream ? [userId] : [])];
  })();

  // Toggle participants panel
  const toggleParticipants = useCallback((): void => {
    setShowParticipants(prev => !prev);
  }, []);

  // Connection status helper
  const getConnectionStatus = useCallback(() => {
    if (error) return 'error';
    if (isConnecting) return 'connecting';
    if (isLoading) return 'loading';
    if (isConnected) return 'connected';
    return 'disconnected';
  }, [error, isConnecting, isLoading, isConnected]);

  // Debug: log connection state in a way that doesn't cause re-renders
  const prevConnectionState = useRef({ isConnected, isConnecting, isLoading, error });
  const connectionCheckCount = useRef(0);

  useEffect(() => {
    // Only log when connection state changes
    const hasStateChanged =
      prevConnectionState.current.isConnected !== isConnected ||
      prevConnectionState.current.isConnecting !== isConnecting ||
      prevConnectionState.current.isLoading !== isLoading ||
      prevConnectionState.current.error !== error;

    if (hasStateChanged) {
      console.log('[Room] Connection state changed:', {
        isConnected,
        isConnecting,
        isLoading,
        errorPresent: !!error,
        errorMessage: error,
        peers: peers.length,
        hasLocalStream: !!localStream,
        peerStreamCount: Object.keys(peerStreams).length,
        renderCount: rendersRef.current,
      });

      // Update the ref
      prevConnectionState.current = { isConnected, isConnecting, isLoading, error };
    }

    // Periodic check for stable connection (debugging purposes only)
    connectionCheckCount.current += 1;
    if (connectionCheckCount.current % 20 === 0) {
      console.log('[Room] Periodic connection check:', {
        connected: isConnected,
        loading: isLoading,
        connecting: isConnecting,
        error: error ? 'yes' : 'no',
        renderCount: rendersRef.current,
      });
    }
  }, [isConnected, isConnecting, isLoading, error, peers.length, localStream, peerStreams]);

  useEffect(() => {
    // Track when a peer stops sharing but we're still showing their stream
    if (
      selectedStream &&
      selectedStream !== userId &&
      selectedStream in peerStreamsWithData &&
      !peerStreamsWithData[selectedStream]?.isSharing
    ) {
      console.log('Selected peer is no longer sharing, clearing selection', selectedStream);
      selectStream(null);

      // Find another peer who is sharing to show instead
      const sharingPeer = Object.entries(peerStreamsWithData).find(
        ([, data]) => data?.isSharing && data?.streamReady
      )?.[0];

      if (sharingPeer) {
        console.log('Switching to another sharing peer:', sharingPeer);
        selectStream(sharingPeer);
      }
    }
  }, [selectedStream, userId, peerStreamsWithData, selectStream]);

  useEffect(() => {
    // Check for stale sharing statuses every 5 seconds
    const checkSharingInterval = setInterval(() => {
      // Iterate through peers who are marked as sharing
      Object.entries(peerStreamsWithData).forEach(([peerId, data]) => {
        if (data?.isSharing && (!data.stream || !data.streamReady)) {
          // This peer is marked as sharing but we don't have their stream
          // Request their stream again
          console.log('Auto-requesting stream from peer marked as sharing:', peerId);
          requestStream(peerId);
        }
      });
    }, 5000);

    return () => clearInterval(checkSharingInterval);
  }, [peerStreamsWithData, requestStream]);

  // Handle missing tracks/stream detection and fix
  useEffect(() => {
    // Check if we're supposed to be viewing a peer's stream but it's not loading properly
    if (
      selectedStream &&
      selectedStream !== userId &&
      selectedStream in peerStreamsWithData &&
      peerStreamsWithData[selectedStream]?.isSharing &&
      (!peerStreams[selectedStream] || !peerStreamsWithData[selectedStream]?.streamReady)
    ) {
      console.log(
        'Detected peer stream issue - stream marked as sharing but not available:',
        selectedStream
      );

      // Try to automatically request the stream once
      const requestStreamTimeout = setTimeout(() => {
        console.log('Auto-requesting stream after detection of sharing but missing stream');
        requestStream(selectedStream);
      }, 2000);

      return () => clearTimeout(requestStreamTimeout);
    }
  }, [selectedStream, userId, peerStreamsWithData, peerStreams, requestStream]);

  // Initialize automatic connection for first sharing
  useEffect(() => {
    // Check if we are supposed to be receiving a screen share
    const sharingPeers = Object.entries(peerStreamsWithData).filter(
      ([id, data]) => id !== userId && data?.isSharing
    );

    if (sharingPeers.length > 0) {
      // Someone is sharing, make sure we can see their stream
      sharingPeers.forEach(([peerId, data]) => {
        if (!peerStreams[peerId] || !data.streamReady) {
          console.log(
            'Auto-requesting stream from peer marked as sharing (first share fix):',
            peerId
          );
          requestStream(peerId);

          // Try a delayed second request which often fixes the first connection
          setTimeout(() => {
            console.log('Second auto-request attempt for first share');
            requestStream(peerId);
          }, 2000);
        }
      });
    }
  }, [peerStreamsWithData, peerStreams, userId, requestStream]);

  return (
    <div className="min-h-screen bg-secondary-50 flex flex-col">
      {/* Header */}
      <header className="bg-white shadow-sm p-4">
        <div className="container mx-auto flex items-center justify-between">
          <button
            onClick={() => {
              // First, ensure all video tracks are stopped
              if (videoRef.current && videoRef.current.srcObject) {
                const mediaStream = videoRef.current.srcObject as MediaStream;
                mediaStream.getTracks().forEach(track => {
                  console.log(`Stopping track on leave room: ${track.kind} (${track.id})`);
                  track.stop();
                });
                videoRef.current.srcObject = null;
              }

              // Stop screen sharing through the WebRTC hook
              if (localStream) {
                localStream.getTracks().forEach(track => {
                  console.log(`Stopping local stream track: ${track.kind} (${track.id})`);
                  track.stop();
                });
                stopSharing();
                setIsSharingScreen(false);
              }

              // Finally navigate away
              onLeaveRoom();
            }}
            className="text-secondary-600 hover:text-secondary-800 flex items-center gap-1"
          >
            <ArrowLeft size={18} />
            <span>Leave Room</span>
          </button>

          <div className="flex items-center gap-3">
            {/* Connection status indicator */}
            <div className="flex items-center gap-2">
              <div
                className={`w-2 h-2 rounded-full ${
                  {
                    connected: 'bg-green-500',
                    connecting: 'bg-yellow-500 animate-pulse',
                    loading: 'bg-blue-500 animate-pulse',
                    error: 'bg-red-500',
                    disconnected: 'bg-gray-400',
                  }[getConnectionStatus()]
                }`}
              ></div>
              <span className="text-xs text-secondary-600">
                {
                  {
                    connected: 'Connected',
                    connecting: 'Connecting',
                    loading: 'Loading',
                    error: 'Error',
                    disconnected: 'Disconnected',
                  }[getConnectionStatus()]
                }
              </span>
            </div>

            <button
              type="button"
              onClick={toggleParticipants}
              className={`${showParticipants ? 'bg-primary-600 text-white' : 'bg-secondary-100 text-secondary-700'} hover:bg-primary-700 hover:text-white px-3 py-1 rounded-md flex items-center gap-1 transition-colors`}
            >
              <Users size={16} />
              <span>Participants ({peers.length + 1})</span>
              {activeStreamers.length > 0 && (
                <span className="ml-1 bg-primary-200 text-primary-800 text-xs px-1.5 py-0.5 rounded-full">
                  {activeStreamers.length} sharing
                </span>
              )}
            </button>

            <div className="flex items-center">
              <span className="bg-primary-100 text-primary-800 px-3 py-1 rounded-l-md">
                Room ID: {roomId}
              </span>
              <button
                onClick={copyRoomLink}
                className="bg-primary-600 hover:bg-primary-700 text-white px-3 py-1 rounded-r-md flex items-center gap-1"
              >
                <Copy size={14} />
                <span>{copied ? 'Copied!' : 'Copy Link'}</span>
              </button>
            </div>
          </div>
        </div>
      </header>

      <div className="container mx-auto flex-1 flex flex-col">
        {/* Loading State Only */}
        {(isLoading || isConnecting) && !isConnected && (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600 mx-auto mb-4"></div>
              <p className="text-secondary-600">
                {isConnecting ? 'Establishing connection...' : 'Loading room...'}
              </p>
              <p className="text-xs text-secondary-400 mt-2">Room ID: {roomId}</p>
            </div>
          </div>
        )}

        {/* Connected State - Always show this when connected, even if there are errors */}
        {isConnected && (
          <div className="flex-1 flex gap-4 relative">
            {/* Main Content - Video */}
            <div
              className={`flex-1 bg-white rounded-xl overflow-hidden shadow-md transition-all duration-300 ${showParticipants ? 'mr-80' : ''}`}
            >
              <div className="bg-secondary-900 aspect-video flex items-center justify-center relative">
                {(selectedStream !== null &&
                  // Our own stream
                  ((selectedStream === userId && localStream) ||
                    // Peer's stream with actual media
                    (selectedStream in peerStreamsWithData &&
                      peerStreamsWithData[selectedStream]?.stream &&
                      peerStreamsWithData[selectedStream]?.streamReady))) ||
                localStream ? (
                  <video
                    ref={videoRef}
                    autoPlay
                    playsInline
                    controls
                    className="w-full h-full object-contain"
                    onLoadedData={() => {
                      console.log('Video loaded data successfully');
                    }}
                    onError={e => {
                      console.error('Video error:', e);
                    }}
                  />
                ) : selectedStream !== null &&
                  selectedStream in peerStreamsWithData &&
                  peerStreamsWithData[selectedStream]?.isSharing &&
                  !peerStreamsWithData[selectedStream]?.streamReady ? (
                  // Peer is sharing but stream isn't ready yet
                  <div className="text-center text-secondary-400 p-8 flex flex-col items-center justify-center h-full">
                    <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600 mx-auto mb-4"></div>
                    <p className="mb-2 text-lg font-medium">Connecting to peer's stream...</p>
                    <p className="text-sm text-secondary-500 mb-6 max-w-lg">
                      <strong>Connection issue:</strong> The other user is sharing their screen, but
                      you can't see it yet. This is a common issue with the first share attempt.
                    </p>

                    <div className="grid grid-cols-1 gap-4 max-w-lg mx-auto">
                      <button
                        onClick={() => {
                          console.log('Forcing reconnection to peer stream:', selectedStream);

                          // First request the stream directly
                          requestStream(selectedStream);

                          // Schedule a second request attempt
                          setTimeout(() => {
                            console.log('Secondary reconnection attempt');
                            requestStream(selectedStream);

                            // Clear and reselect the stream
                            selectStream(null);
                            setTimeout(() => selectStream(selectedStream), 200);
                          }, 1500);
                        }}
                        className="px-4 py-3 bg-blue-600 text-white rounded-md hover:bg-blue-700 font-medium flex items-center justify-center"
                      >
                        <RefreshCw size={18} className="mr-2" />
                        Reconnect to Stream
                      </button>

                      <div className="text-center text-sm text-secondary-500 my-2">
                        Or try this trick that typically fixes the issue:
                      </div>

                      <button
                        onClick={async () => {
                          try {
                            if (!localStream) {
                              console.log('Starting temporary screen share to fix connection');

                              // Remember the peer we were trying to view
                              const peerToView = selectedStream;

                              // Share our screen temporarily
                              const stream = await shareScreen();
                              if (stream) {
                                setIsSharingScreen(true);

                                // Schedule auto-stop after a few seconds
                                setTimeout(() => {
                                  console.log('Auto-stopping temporary screen share');
                                  stopSharing();
                                  setIsSharingScreen(false);

                                  // Request peer stream again
                                  if (peerToView) {
                                    console.log('Requesting peer stream after temporary share');
                                    requestStream(peerToView);

                                    // Reselect peer stream after a delay
                                    setTimeout(() => selectStream(peerToView), 1000);
                                  }
                                }, 3000);
                              }
                            }
                          } catch (err) {
                            console.error('Error during share fix:', err);
                          }
                        }}
                        className="px-4 py-3 bg-green-600 text-white rounded-md hover:bg-green-700 font-medium flex items-center justify-center"
                      >
                        <Monitor size={18} className="mr-2" />
                        Share Your Screen Temporarily (Fixes Connection)
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="text-center text-secondary-400 p-8">
                    <div>
                      <Monitor size={48} className="mx-auto mb-4 text-secondary-300" />
                      <p className="mb-4">No active screen shares</p>
                      <button
                        onClick={handleShareScreen}
                        className="bg-primary-600 hover:bg-primary-700 text-white px-4 py-2 rounded-md"
                      >
                        Share Your Screen
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* Status bar */}
              <div className="px-4 py-1 border-t border-secondary-100 flex justify-between items-center">
                {/* Left side info */}
                <div className="flex-1 flex items-center gap-2">
                  <div
                    className={`w-3 h-3 rounded-full ${activeStreamers.length > 0 ? 'bg-green-500' : 'bg-secondary-300'}`}
                  ></div>
                  <span className="text-secondary-700">
                    {selectedStream
                      ? `Viewing: ${selectedStream === userId ? 'Your screen' : `Participant ${selectedStream.substring(0, 8)}`}`
                      : activeStreamers.length > 0
                        ? 'Select a participant to view their screen'
                        : 'No active screen shares'}
                  </span>
                </div>

                {/* Error display */}
                {error && (
                  <div className="flex items-center gap-2 bg-red-50 px-2 py-1 rounded border border-red-200 mr-2">
                    <div className="flex-1">
                      <p className="text-sm text-red-700">
                        {error.startsWith('Cannot share screen - another user')
                          ? 'Cannot share - another user is already sharing'
                          : error}
                      </p>
                    </div>
                    <button
                      onClick={() => {
                        setError(null);
                      }}
                      className="bg-red-100 hover:bg-red-200 text-red-700 px-2 py-1 rounded text-xs flex items-center gap-1"
                    >
                      <X className="w-3 h-3" />
                      Dismiss
                    </button>
                  </div>
                )}

                {/* Action buttons */}
                <div className="space-x-2">
                  {isSharingScreen ? (
                    <button
                      onClick={handleStopSharing}
                      className="bg-red-600 hover:bg-red-700 text-white px-3 py-1 rounded-md text-sm"
                    >
                      Stop Sharing
                    </button>
                  ) : (
                    <button
                      onClick={handleShareScreen}
                      className="bg-primary-600 hover:bg-primary-700 text-white px-3 py-1 rounded-md text-sm"
                    >
                      Share Screen
                    </button>
                  )}
                </div>
              </div>

              {/* Connection Error Bar */}
              {error && (
                <div className="px-4 py-2 bg-red-50 border-t border-red-200 flex items-center gap-2">
                  <div className="bg-red-100 text-red-600 rounded-full w-6 h-6 flex items-center justify-center flex-shrink-0">
                    <X size={14} />
                  </div>
                  <div className="flex-1">
                    <p className="text-sm text-red-700">Connection Error: {error}</p>
                  </div>
                  <button
                    onClick={() => {
                      // Try to reconnect using the WebRTC hook's functionality
                      if (roomId) {
                        // Force disconnect and reconnect
                        window.location.href = `/room/${roomId}`;
                      }
                    }}
                    className="bg-red-100 hover:bg-red-200 text-red-700 px-2 py-1 rounded text-xs flex items-center gap-1"
                  >
                    <RefreshCw size={12} />
                    <span>Reconnect</span>
                  </button>
                </div>
              )}
            </div>

            {/* Participants Panel - Slide in from right */}
            <div
              className={`fixed top-[73px] right-0 bottom-0 w-80 bg-white shadow-lg overflow-hidden flex flex-col transition-all duration-300 transform ${
                showParticipants ? 'translate-x-0' : 'translate-x-full'
              } z-10`}
            >
              <div className="p-4 border-b border-secondary-100 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Users size={18} className="text-secondary-600" />
                  <h2 className="font-medium">Participants</h2>
                </div>

                <button
                  type="button"
                  onClick={toggleParticipants}
                  className="text-secondary-400 hover:text-secondary-700 p-1 rounded-full hover:bg-secondary-100"
                  aria-label="Close panel"
                >
                  <X size={18} />
                </button>
              </div>

              <div className="flex-1 overflow-auto p-2">
                <div className="space-y-1">
                  {/* Current user */}
                  <button
                    type="button"
                    onClick={() => (localStream ? selectStream(userId) : null)}
                    disabled={!localStream}
                    className={`w-full text-left p-2 rounded-md 
                      ${
                        selectedStream === userId
                          ? 'bg-primary-100'
                          : localStream
                            ? 'bg-primary-50 hover:bg-primary-50'
                            : 'bg-secondary-50'
                      } 
                      flex items-center gap-3 transition-colors`}
                  >
                    <div
                      className={`${
                        selectedStream === userId
                          ? 'bg-primary-200 text-primary-700'
                          : localStream
                            ? 'bg-primary-100 text-primary-700'
                            : 'bg-secondary-100 text-secondary-600'
                      } 
                      w-8 h-8 rounded-full flex items-center justify-center`}
                    >
                      <span>You</span>
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-secondary-800">You</span>
                        {localStream && (
                          <span className="text-xs bg-primary-100 text-primary-700 px-2 py-0.5 rounded-full flex items-center gap-1">
                            <span>Sharing</span>
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-secondary-500">{userId.substring(0, 8)}</div>
                    </div>
                    {localStream && selectedStream !== userId && (
                      <div className="text-xs text-primary-600">View</div>
                    )}
                  </button>

                  {/* Other participants */}
                  {peers.map((peerId: string) => (
                    <button
                      key={peerId}
                      type="button"
                      onClick={() =>
                        peerId in peerStreams && peerStreamsWithData[peerId]?.isSharing
                          ? selectStream(peerId)
                          : null
                      }
                      disabled={!(peerId in peerStreams && peerStreamsWithData[peerId]?.isSharing)}
                      className={`w-full text-left p-2 rounded-md 
                        ${
                          selectedStream === peerId
                            ? 'bg-primary-100'
                            : peerId in peerStreams && peerStreamsWithData[peerId]?.isSharing
                              ? 'hover:bg-primary-50'
                              : 'hover:bg-secondary-50 cursor-default'
                        } 
                        flex items-center gap-3 transition-colors`}
                    >
                      <div
                        className={`${
                          selectedStream === peerId
                            ? 'bg-primary-200 text-primary-700'
                            : peerId in peerStreams && peerStreamsWithData[peerId]?.isSharing
                              ? 'bg-primary-100 text-primary-700'
                              : 'bg-secondary-100 text-secondary-600'
                        } 
                        w-8 h-8 rounded-full flex items-center justify-center`}
                      >
                        <span>P</span>
                      </div>
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-secondary-800">Participant</span>
                          {/* Update sharing label to check for both isSharing flag AND valid stream */}
                          {peerId in peerStreams &&
                            peerStreamsWithData[peerId]?.isSharing &&
                            peerStreamsWithData[peerId]?.streamReady && (
                              <span className="text-xs bg-primary-100 text-primary-700 px-2 py-0.5 rounded-full flex items-center gap-1">
                                <span>
                                  {peerStreams[peerId]
                                    ? `Sharing${peerStreams[peerId]?.getVideoTracks().length ? '' : ' (no video)'}`
                                    : 'Starting stream...'}
                                </span>
                              </span>
                            )}
                          {/* Show different status for stalled sharing */}
                          {peerId in peerStreamsWithData &&
                            peerStreamsWithData[peerId]?.isSharing &&
                            (!peerStreams[peerId] || !peerStreamsWithData[peerId]?.streamReady) && (
                              <span className="text-xs bg-yellow-100 text-yellow-700 px-2 py-0.5 rounded-full flex items-center gap-1">
                                <RefreshCw size={10} className="animate-spin mr-1" />
                                <span>Connecting...</span>
                              </span>
                            )}
                        </div>
                        <div className="text-xs text-secondary-500">{peerId.substring(0, 8)}</div>
                      </div>
                      {peerId in peerStreams &&
                        peerStreamsWithData[peerId]?.isSharing &&
                        selectedStream !== peerId && (
                          <div className="text-xs text-primary-600">View</div>
                        )}
                    </button>
                  ))}
                </div>
              </div>

              <div className="p-4 border-t border-secondary-100 bg-secondary-50">
                <div className="text-xs text-secondary-600">
                  <p className="mb-1">Room link:</p>
                  <div className="flex items-center gap-1">
                    <span className="truncate font-mono bg-white p-1 rounded border border-secondary-200 flex-1">
                      {window.location.origin}/room/{roomId}
                    </span>
                    <button
                      type="button"
                      onClick={copyRoomLink}
                      className="text-primary-600 hover:text-primary-800"
                      aria-label="Copy link"
                    >
                      <Copy size={14} />
                    </button>
                  </div>
                </div>
              </div>
            </div>

            {/* Clean up visual indicators for peers who stopped sharing */}
            {selectedStream !== null &&
              selectedStream in peerStreamsWithData &&
              !peerStreamsWithData[selectedStream]?.isSharing && (
                <div className="absolute top-2 right-2 bg-yellow-100 text-yellow-800 px-3 py-1 rounded-md text-sm flex items-center gap-1 z-20">
                  <RefreshCw size={14} />
                  <span>Peer stopped sharing</span>
                  <button
                    onClick={() => selectStream(null)}
                    className="ml-2 bg-yellow-200 hover:bg-yellow-300 text-yellow-800 px-1 rounded"
                  >
                    <X size={14} />
                  </button>
                </div>
              )}
          </div>
        )}
      </div>
    </div>
  );
}
