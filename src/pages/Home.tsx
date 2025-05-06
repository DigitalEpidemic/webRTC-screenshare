import React, { useState } from 'react';
import { Monitor, Copy, ArrowRight, RefreshCw } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';

interface HomeProps {
  onJoinRoom: (roomId: string) => void;
}

export function Home({ onJoinRoom }: HomeProps): React.ReactElement {
  const [newRoomId, setNewRoomId] = useState<string>('');
  const [joinRoomId, setJoinRoomId] = useState<string>('');
  const [copied, setCopied] = useState<boolean>(false);
  const [error, setError] = useState<string>('');

  // Generate a random room ID
  const generateRoomId = (): string => {
    const id = uuidv4().substring(0, 8);
    setNewRoomId(id);
    setCopied(false);
    return id;
  };

  // Copy room link to clipboard
  const copyToClipboard = (): void => {
    const url = `${window.location.origin}/room/${newRoomId}`;
    navigator.clipboard.writeText(url);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Handle creating a new room
  const handleCreateRoom = (): void => {
    const roomId = newRoomId || generateRoomId();
    onJoinRoom(roomId);
  };

  // Handle joining an existing room
  const handleJoinRoom = (): void => {
    if (!joinRoomId) {
      setError('Please enter a room ID');
      return;
    }
    setError('');
    onJoinRoom(joinRoomId);
  };

  return (
    <div className="container mx-auto max-w-4xl px-4 py-12">
      <div className="text-center mb-8">
        <h1 className="text-4xl font-bold text-primary-900 mb-2">Screen Share</h1>
        <p className="text-secondary-600 text-lg">
          Create or join a room to collaborate with screen sharing
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
        {/* Create Room Section */}
        <div className="bg-white rounded-xl shadow-lg p-6 border border-secondary-200">
          <h2 className="text-2xl font-semibold text-primary-800 mb-4">Create a Room</h2>
          <p className="text-secondary-600 mb-6">Create a new room and invite others to join</p>

          <div className="flex items-center gap-2 mb-6">
            <input
              type="text"
              value={newRoomId}
              onChange={e => setNewRoomId(e.target.value)}
              placeholder="Room ID (auto-generated)"
              className="w-full p-3 border border-secondary-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
            <button
              onClick={generateRoomId}
              className="p-3 bg-secondary-100 text-secondary-700 rounded-lg hover:bg-secondary-200 transition-colors"
              aria-label="Generate new room ID"
            >
              <RefreshCw size={20} />
            </button>
          </div>

          {newRoomId && (
            <div className="mb-6">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-secondary-700">Share this link:</span>
                <button
                  onClick={copyToClipboard}
                  className="text-primary-600 hover:text-primary-800 flex items-center gap-1 text-sm"
                >
                  <Copy size={14} /> {copied ? 'Copied!' : 'Copy'}
                </button>
              </div>
              <div className="p-3 bg-secondary-50 rounded-lg text-secondary-800 font-mono text-sm truncate">
                {window.location.origin}/room/{newRoomId}
              </div>
            </div>
          )}

          <button
            onClick={handleCreateRoom}
            className="w-full flex items-center justify-center gap-2 bg-primary-600 text-white p-3 rounded-lg hover:bg-primary-700 transition-colors"
          >
            <Monitor size={20} />
            <span>Create Room</span>
          </button>
        </div>

        {/* Join Room Section */}
        <div className="bg-white rounded-xl shadow-lg p-6 border border-secondary-200">
          <h2 className="text-2xl font-semibold text-primary-800 mb-4">Join a Room</h2>
          <p className="text-secondary-600 mb-6">Enter a room ID to join an existing room</p>

          <div className="mb-6">
            <input
              type="text"
              value={joinRoomId}
              onChange={e => setJoinRoomId(e.target.value)}
              placeholder="Enter Room ID"
              className="w-full p-3 border border-secondary-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
            {error && <p className="mt-2 text-red-600 text-sm">{error}</p>}
          </div>

          <button
            onClick={handleJoinRoom}
            className="w-full flex items-center justify-center gap-2 bg-secondary-600 text-white p-3 rounded-lg hover:bg-secondary-700 transition-colors"
          >
            <ArrowRight size={20} />
            <span>Join Room</span>
          </button>
        </div>
      </div>

      <div className="mt-12 text-center">
        <h2 className="text-xl font-semibold text-primary-800 mb-4">How It Works</h2>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 text-left">
          <div className="bg-white p-4 rounded-lg">
            <h3 className="font-medium mb-2 text-primary-700">1. Create or Join a Room</h3>
            <p className="text-secondary-600">Create a new room or join with a room ID</p>
          </div>
          <div className="bg-white p-4 rounded-lg">
            <h3 className="font-medium mb-2 text-primary-700">2. Share Your Screen</h3>
            <p className="text-secondary-600">Anyone in the room can share their screen</p>
          </div>
          <div className="bg-white p-4 rounded-lg">
            <h3 className="font-medium mb-2 text-primary-700">3. View Any Participant's Screen</h3>
            <p className="text-secondary-600">Click on participants to view their shared screens</p>
          </div>
        </div>
      </div>
    </div>
  );
}
