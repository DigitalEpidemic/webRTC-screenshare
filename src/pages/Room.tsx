import React, { useState, useEffect, useRef } from 'react';
import { Monitor, Copy, X, Users, ArrowLeft, VideoOff } from 'lucide-react';
import { useWebRTC } from '../hooks/useWebRTC';

interface RoomProps {
  roomId: string;
  onLeaveRoom: () => void;
}

export function Room({ roomId, onLeaveRoom }: RoomProps): React.ReactElement {
  const [copied, setCopied] = useState<boolean>(false);
  const [isSharingScreen, setIsSharingScreen] = useState<boolean>(false);
  const [showParticipants, setShowParticipants] = useState<boolean>(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const videoContainerRef = useRef<HTMLDivElement>(null);
  
  const {
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
    userId
  } = useWebRTC({ roomId });

  // Set the video stream
  useEffect(() => {
    if (videoRef.current) {
      let streamToShow: MediaStream | null = null;
      
      // Determine which stream to show
      if (selectedStream) {
        // If selected stream is our own
        if (selectedStream === userId && localStream) {
          streamToShow = localStream;
          console.log('Showing local stream');
        } 
        // If selected stream is from a peer
        else if (selectedStream in peerStreams && peerStreams[selectedStream]) {
          streamToShow = peerStreams[selectedStream];
          console.log(`Showing peer stream from ${selectedStream}`);
          
          // Double-check the stream has video tracks
          if (streamToShow && streamToShow.getVideoTracks().length === 0) {
            console.warn(`Stream from ${selectedStream} has no video tracks`);
          }
        }
      } 
      // Default: show our own stream if no selection
      else if (localStream) {
        streamToShow = localStream;
        console.log('No selection, defaulting to local stream');
      }
      
      // Apply the stream with additional checks
      if (streamToShow) {
        console.log('Setting video stream', streamToShow.id, 'with tracks:', 
          streamToShow.getTracks().map(t => `${t.kind}:${t.id}:${t.enabled ? 'enabled' : 'disabled'}`).join(', '));
        
        // Check if stream has any enabled video tracks
        const hasEnabledVideo = streamToShow.getVideoTracks().some(track => track.enabled);
        if (!hasEnabledVideo) {
          console.warn(`Stream ${streamToShow.id} has no enabled video tracks`);
        }
        
        // Set the stream
        videoRef.current.srcObject = streamToShow;
      } else {
        console.log('No stream to show');
        videoRef.current.srcObject = null;
      }
    }
  }, [localStream, peerStreams, selectedStream, userId]);

  // Handle screen sharing
  const handleShareScreen = async (): Promise<void> => {
    if (isSharingScreen) {
      stopSharing();
      setIsSharingScreen(false);
    } else {
      try {
        const result = await shareScreen();
        if (result) {
          setIsSharingScreen(true);
          // Auto-select our own stream
          selectStream(userId);
        }
      } catch (err) {
        console.error('Error sharing screen:', err);
      }
    }
  };

  // Copy room link to clipboard
  const copyRoomLink = (): void => {
    const url = `${window.location.origin}/room/${roomId}`;
    navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Find active streamers (peers with streams + local user if sharing)
  const activeStreamers = [
    ...Object.keys(peerStreams).filter(id => peerStreams[id] !== null),
    ...(localStream ? [userId] : [])
  ];

  // Debug: log streams for troubleshooting with more detailed information
  useEffect(() => {
    console.log('Active streams:', {
      localStream: localStream ? 'yes' : 'no',
      peerStreams: Object.keys(peerStreams),
      peerStreamsWithData: Object.entries(peerStreams).map(([id, stream]) => ({
        id,
        hasStream: !!stream,
        trackCount: stream ? (stream as MediaStream).getTracks().length : 0,
        videoTracks: stream ? (stream as MediaStream).getVideoTracks().length : 0
      })),
      selected: selectedStream
    });

    // Log all participants for clarity
    console.log('All participants:', [
      { id: userId, isMe: true, isSharing: !!localStream },
      ...peers.map((peerId: string) => ({ 
        id: peerId, 
        isMe: false, 
        isSharing: peerId in peerStreams && peerStreams[peerId] !== null
      }))
    ]);
  }, [localStream, peerStreams, selectedStream, peers, userId]);

  // Toggle participants panel
  const toggleParticipants = (): void => {
    setShowParticipants(prev => !prev);
  };

  return (
    <div className="min-h-screen bg-secondary-50 flex flex-col">
      {/* Header */}
      <header className="bg-white shadow-sm p-4">
        <div className="container mx-auto flex items-center justify-between">
          <button 
            onClick={onLeaveRoom}
            className="text-secondary-600 hover:text-secondary-800 flex items-center gap-1"
          >
            <ArrowLeft size={18} />
            <span>Leave Room</span>
          </button>
          
          <div className="flex items-center gap-3">
            <button
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
        {/* Loading and Error States */}
        {isLoading && (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center">
              <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600 mx-auto mb-4"></div>
              <p className="text-secondary-600">Connecting to room...</p>
            </div>
          </div>
        )}

        {error && (
          <div className="flex-1 flex items-center justify-center">
            <div className="text-center bg-red-50 p-6 rounded-lg shadow-sm max-w-md">
              <div className="bg-red-100 text-red-600 rounded-full w-12 h-12 flex items-center justify-center mx-auto mb-4">
                <X size={24} />
              </div>
              <h2 className="text-xl font-semibold text-red-700 mb-2">Connection Error</h2>
              <p className="text-red-600 mb-4">{error}</p>
              <button 
                onClick={onLeaveRoom}
                className="bg-secondary-600 hover:bg-secondary-700 text-white px-4 py-2 rounded-md"
              >
                Return Home
              </button>
            </div>
          </div>
        )}

        {/* Connected State */}
        {isConnected && !isLoading && !error && (
          <div className="flex-1 flex gap-4 relative">
            {/* Main Content - Video */}
            <div className={`flex-1 bg-white rounded-xl overflow-hidden shadow-md transition-all duration-300 ${showParticipants ? 'mr-80' : ''}`}>
              <div 
                ref={videoContainerRef}
                className="bg-secondary-900 aspect-video flex items-center justify-center relative"
              >
                {(selectedStream && (
                  // Our own stream
                  (selectedStream === userId && localStream) || 
                  // Peer's stream with actual media (not null)
                  (selectedStream in peerStreams && peerStreams[selectedStream] !== null)
                )) || localStream ? (
                  <video
                    ref={videoRef}
                    autoPlay
                    playsInline
                    controls
                    className="w-full h-full object-contain"
                  />
                ) : selectedStream && selectedStream in peerStreams && peerStreams[selectedStream] === null ? (
                  // Peer is sharing but we haven't received their stream yet
                  <div className="text-center text-secondary-400 p-8">
                    <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600 mx-auto mb-4"></div>
                    <p className="mb-2">Connecting to peer's stream...</p>
                    <p className="text-sm text-secondary-500">This may take a moment</p>
                    <button 
                      onClick={() => {
                        // Try to manually request the peer's stream
                        console.log("Manually requesting stream from", selectedStream);
                        
                        // Try reselecting the stream
                        if (selectedStream) {
                          selectStream(selectedStream);
                        }
                        
                        // This implementation doesn't directly access socket but triggers a reconnection attempt
                        setTimeout(() => {
                          if (selectedStream) {
                            selectStream(selectedStream);
                          }
                        }, 1000);
                      }}
                      className="mt-4 px-3 py-1 bg-primary-600 text-white rounded-md hover:bg-primary-700 text-sm"
                    >
                      Retry Connection
                    </button>
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
                <div className="flex items-center gap-2">
                  <div className={`w-3 h-3 rounded-full ${activeStreamers.length > 0 ? 'bg-green-500' : 'bg-secondary-300'}`}></div>
                  <span className="text-secondary-700">
                    {selectedStream 
                      ? `Viewing: ${selectedStream === userId ? 'Your screen' : `Participant ${selectedStream.substring(0, 8)}`}` 
                      : activeStreamers.length > 0 
                        ? 'Select a participant to view their screen' 
                        : 'No active screen shares'}
                  </span>
                </div>
                
                {!isSharingScreen ? (
                  <button
                    onClick={handleShareScreen}
                    className="bg-primary-600 hover:bg-primary-700 text-white px-3 py-1 rounded-md flex items-center gap-1 text-sm"
                  >
                    <Monitor size={14} />
                    <span>Share Screen</span>
                  </button>
                ) : (
                  <button
                    onClick={handleShareScreen}
                    className="bg-red-600 hover:bg-red-700 text-white px-3 py-1 rounded-md flex items-center gap-1 text-sm"
                  >
                    <VideoOff size={14} />
                    <span>Stop Sharing</span>
                  </button>
                )}
              </div>
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
                    onClick={() => localStream ? selectStream(userId) : null}
                    disabled={!localStream}
                    className={`w-full text-left p-2 rounded-md 
                      ${selectedStream === userId ? 'bg-primary-100' : 
                        localStream ? 'bg-primary-50 hover:bg-primary-50' : 'bg-secondary-50'} 
                      flex items-center gap-3 transition-colors`}
                  >
                    <div className={`${selectedStream === userId ? 'bg-primary-200 text-primary-700' : 
                      localStream ? 'bg-primary-100 text-primary-700' : 'bg-secondary-100 text-secondary-600'} 
                      w-8 h-8 rounded-full flex items-center justify-center`}>
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
                      onClick={() => peerId in peerStreams ? selectStream(peerId) : null}
                      disabled={!(peerId in peerStreams)}
                      className={`w-full text-left p-2 rounded-md 
                        ${selectedStream === peerId ? 'bg-primary-100' : 
                          peerId in peerStreams ? 'hover:bg-primary-50' : 'hover:bg-secondary-50'} 
                        flex items-center gap-3 transition-colors`}
                    >
                      <div className={`${selectedStream === peerId ? 'bg-primary-200 text-primary-700' : 
                        peerId in peerStreams ? 'bg-primary-100 text-primary-700' : 'bg-secondary-100 text-secondary-600'} 
                        w-8 h-8 rounded-full flex items-center justify-center`}>
                        <span>P</span>
                      </div>
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-secondary-800">Participant</span>
                          {peerId in peerStreams && (
                            <span className="text-xs bg-primary-100 text-primary-700 px-2 py-0.5 rounded-full flex items-center gap-1">
                              <span>
                                {peerStreams[peerId] ? 
                                  `Sharing${peerStreams[peerId]?.getVideoTracks().length ? '' : ' (no video)'}` : 
                                  'Starting stream...'}
                              </span>
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-secondary-500">{peerId.substring(0, 8)}</div>
                      </div>
                      {peerId in peerStreams && selectedStream !== peerId && (
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
          </div>
        )}
      </div>
    </div>
  );
}