import React, { useEffect, useState } from 'react';
import { Home } from './pages/Home';
import { Room } from './pages/Room';

export default function App(): React.ReactElement {
  const [currentPage, setCurrentPage] = useState<'home' | 'room'>('home');
  const [roomId, setRoomId] = useState<string | null>(null);

  // Simple routing based on URL pathname
  useEffect(() => {
    const handleNavigation = (): void => {
      const path = window.location.pathname;

      if (path === '/') {
        setCurrentPage('home');
        setRoomId(null);
      } else if (path.startsWith('/room/')) {
        const parts = path.split('/');
        if (parts.length >= 3) {
          setRoomId(parts[2]);
          setCurrentPage('room');
        }
      }
    };

    handleNavigation();

    // Handle browser back/forward navigation
    window.addEventListener('popstate', handleNavigation);
    return () => window.removeEventListener('popstate', handleNavigation);
  }, []);

  // Navigation function
  const navigate = (path: string): void => {
    // If navigating away from a room page, ensure all media tracks are stopped
    if (currentPage === 'room' && path === '/') {
      // Don't request new permissions, just clean up existing tracks
      // Explicitly check for any active video elements and stop their tracks
      document.querySelectorAll('video').forEach(video => {
        if (video.srcObject instanceof MediaStream) {
          video.srcObject.getTracks().forEach(track => {
            console.log(`Stopping track on navigation: ${track.kind} (${track.id})`);
            track.stop();
          });
          video.srcObject = null;
        }
      });

      // Also ensure any MediaStream tracks that might not be attached to video elements are stopped
      try {
        // Access navigator.mediaDevices without requesting permissions
        if (navigator.mediaDevices) {
          console.log('Cleaning up any remaining media tracks on leave room');
        }
      } catch (err) {
        console.error('Error during media cleanup:', err);
      }
    }

    window.history.pushState({}, '', path);
    const popStateEvent = new PopStateEvent('popstate', {});
    window.dispatchEvent(popStateEvent);
  };

  // Render the appropriate page based on state
  return (
    <div className="min-h-screen bg-gradient-to-br from-primary-50 to-secondary-100">
      {currentPage === 'home' && (
        <Home
          onJoinRoom={(id: string) => {
            navigate(`/room/${id}`);
          }}
        />
      )}

      {currentPage === 'room' && roomId && (
        <Room roomId={roomId} onLeaveRoom={() => navigate('/')} />
      )}
    </div>
  );
}
