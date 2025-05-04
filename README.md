# Screen Share Application

A modern WebRTC-based screen sharing application that allows real-time collaboration through secure peer-to-peer connections.

## Features

- **Room Creation & Joining**: Create rooms with auto-generated or custom IDs, or join existing rooms
- **Real-time Screen Sharing**: Share your screen with all participants in the room
- **Multi-participant Support**: Multiple users can join the same room
- **Stream Selection**: View any participant's shared screen by selecting them from the participants panel
- **Responsive Design**: Works across various screen sizes with a clean, modern interface

## Technology Stack

- **Frontend**: React with functional components and hooks
- **UI Styling**: Tailwind CSS
- **Icons**: Lucide React
- **WebRTC**: Native WebRTC API for peer connections
- **Signaling**: Socket.IO for WebRTC signaling
- **UUID Generation**: uuid for room ID creation

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

1. **Creating a Room**:
   - Visit the home page
   - Use the auto-generated room ID or enter a custom one
   - Click "Create Room" to start a new session
   - Share the generated room link with others you want to invite

2. **Joining a Room**:
   - Enter a room ID in the "Join a Room" section
   - Click "Join Room" to enter an existing session
   - Alternatively, use a shared room link

3. **Sharing Your Screen**:
   - Once in a room, click the "Share Screen" button at the bottom of the video area
   - Select which screen/window/tab you want to share in the browser dialog
   - To stop sharing, click "Stop Sharing" or end the share from your browser's UI

4. **Viewing Shared Screens**:
   - Open the "Participants" panel to see who is sharing their screen
   - Click on any participant who is sharing to view their screen
   - You can switch between different shared screens at any time

5. **Leaving a Room**:
   - Click "Leave Room" in the top-left corner to exit and return to the home page

## How it Works

The application uses WebRTC for direct peer-to-peer connections between participants:

1. When you join a room, a WebSocket connection is established with the signaling server
2. The server helps coordinate the initial connection between peers (signaling)
3. Once connected, video streams flow directly between participants without going through a server
4. This provides low-latency, high-quality screen sharing with good scalability

## Browser Compatibility

This application works best in modern browsers with WebRTC support:
- Google Chrome (recommended)
- Firefox
- Microsoft Edge
- Safari (may have limited functionality)

## License

This project is licensed under the MIT License.

## Acknowledgments

- [WebRTC](https://webrtc.org/) for the real-time communication technology
- [Simple-Peer](https://github.com/feross/simple-peer) for simplifying WebRTC implementation
- [Tailwind CSS](https://tailwindcss.com/) for the styling framework
- [Lucide Icons](https://lucide.dev/) for the beautiful icons 