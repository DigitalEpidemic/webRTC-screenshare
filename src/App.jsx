import React, { useState, useEffect } from 'react';
import { Home } from './pages/Home';
import { Room } from './pages/Room';

export default function App() {
  const [currentPage, setCurrentPage] = useState('home');
  const [roomId, setRoomId] = useState(null);
  const [role, setRole] = useState(null);

  // Simple routing based on URL pathname
  useEffect(() => {
    const handleNavigation = () => {
      const path = window.location.pathname;
      
      if (path === '/') {
        setCurrentPage('home');
        setRoomId(null);
        setRole(null);
      } else if (path.startsWith('/room/')) {
        const parts = path.split('/');
        if (parts.length >= 3) {
          setRoomId(parts[2]);
          setCurrentPage('room');
          
          // Get role from URL if present
          if (parts.length >= 4 && (parts[3] === 'sharer' || parts[3] === 'viewer')) {
            setRole(parts[3]);
          }
        }
      }
    };

    handleNavigation();
    
    // Handle browser back/forward navigation
    window.addEventListener('popstate', handleNavigation);
    return () => window.removeEventListener('popstate', handleNavigation);
  }, []);

  // Navigation function
  const navigate = (path) => {
    window.history.pushState({}, '', path);
    const popStateEvent = new PopStateEvent('popstate', {});
    window.dispatchEvent(popStateEvent);
  };

  // Render the appropriate page based on state
  return (
    <div className="min-h-screen bg-gradient-to-br from-primary-50 to-secondary-100">
      {currentPage === 'home' && (
        <Home onJoinRoom={(id, userRole) => {
          navigate(`/room/${id}/${userRole}`);
        }} />
      )}
      
      {currentPage === 'room' && roomId && (
        <Room 
          roomId={roomId} 
          role={role}
          onLeaveRoom={() => navigate('/')}
        />
      )}
    </div>
  );
} 