# Screen Share Application

A modern, responsive WebRTC screen sharing application with room creation and management.

## Features

- **Room Creation & Management**: Create and join rooms with unique IDs
- **Screen Sharing**: Share your screen with multiple viewers
- **Real-time Communication**: Uses WebRTC for secure, peer-to-peer connections
- **Modern UI**: Beautiful, responsive interface built with React and Tailwind CSS

## Technology Stack

- **Frontend**: React, Tailwind CSS, Lucide Icons
- **Backend**: Node.js, Express
- **WebRTC**: Simple-peer
- **WebSockets**: ws (WebSocket implementation)
- **Build Tools**: Vite, PostCSS

## Getting Started

### Prerequisites

- Node.js (v20.19.1 or higher)
- npm or yarn

### Installation

1. Clone the repository:
   ```bash
   git clone git@github.com:DigitalEpidemic/webRTC-screenshare.git
   cd webRTC-screenshare
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Start the development server:
   ```bash
   npm run dev
   ```
   This will start both the React dev server and the WebSocket signaling server.

4. Visit `http://localhost:5173` in your browser to use the application.

## Usage

1. **Create a Room**:
   - On the home page, click the "Generate" button to create a room ID or enter a custom one
   - Click "Share Screen" to create a room and start sharing your screen
   - Or click "Join as Viewer" to create a room and wait for someone to share

2. **Join a Room**:
   - Enter an existing room ID and click "Join Room"
   - Or use a shared room link

3. **Share Your Screen**:
   - In a room, click the "Share Screen" button
   - Select the screen or application window you want to share
   - Click "Stop Sharing" when you're done

4. **View a Shared Screen**:
   - Join a room where someone is already sharing their screen
   - The shared screen will automatically display

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Acknowledgments

- [WebRTC](https://webrtc.org/) for the real-time communication technology
- [Simple-Peer](https://github.com/feross/simple-peer) for simplifying WebRTC implementation
- [Tailwind CSS](https://tailwindcss.com/) for the styling framework
- [Lucide Icons](https://lucide.dev/) for the beautiful icons 