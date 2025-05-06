# Screen Share Application
[![Netlify Status](https://api.netlify.com/api/v1/badges/003bee4f-392e-4592-b692-476729d7137a/deploy-status)](https://app.netlify.com/sites/screenshare-tool/deploys)

Deployed at: https://screenshare-tool.netlify.app/

A modern WebRTC-based screen sharing application that allows real-time collaboration through secure peer-to-peer connections.

## Features

- **Room Creation & Joining**: Create rooms with auto-generated or custom IDs, or join existing rooms
- **Real-time Screen Sharing**: Share your screen with all participants in the room
- **Multi-participant Support**: Multiple users can join the same room
- **Stream Selection**: View any participant's shared screen by selecting them from the participants panel
- **Responsive Design**: Works across various screen sizes with a clean, modern interface
- **Secure Communication**: Direct peer-to-peer connections with Firebase signaling
- **Real-time Updates**: Live participant status and stream availability notifications
- **Firebase Integration**: Realtime database for room management and signaling

## Technology Stack

- **Frontend**: React 18.2 with TypeScript, functional components and hooks
- **UI Styling**: Tailwind CSS for responsive design
- **Icons**: Lucide React for beautiful, consistent iconography
- **WebRTC**: Native WebRTC API with peer-to-peer connections
- **Signaling & Database**: Firebase Realtime Database for signaling and room management
- **UUID Generation**: uuid package for room ID creation
- **Development**: Vite for fast development experience with hot module replacement

## Getting Started

### Prerequisites

- Node.js (v20.19.1 or higher recommended)
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

3. Set up environment variables for Firebase:
   
   Rename `.env.example` to `.env` and populate the following variables:

   ```
   VITE_FIREBASE_API_KEY=your_api_key
   VITE_FIREBASE_AUTH_DOMAIN=your_auth_domain
   VITE_FIREBASE_DATABASE_URL=your_database_url
   VITE_FIREBASE_PROJECT_ID=your_project_id
   VITE_FIREBASE_STORAGE_BUCKET=your_storage_bucket
   VITE_FIREBASE_MESSAGING_SENDER_ID=your_messaging_sender_id
   VITE_FIREBASE_APP_ID=your_app_id
   VITE_FIREBASE_MEASUREMENT_ID=your_measurement_id
   ```

4. Start the development server:

   ```bash
   npm run dev
   ```

   This will start the Vite development server with hot module replacement.

5. Visit `http://localhost:5173` in your browser to use the application.

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

   - Once in a room, click the "Share Screen" button
   - Select which screen/window/tab you want to share in the browser dialog
   - To stop sharing, click "Stop Sharing" or end the share from your browser's UI

4. **Viewing Shared Screens**:

   - See the list of participants who are currently sharing their screens
   - Click on any participant who is sharing to view their screen
   - You can switch between different shared screens at any time

5. **Leaving a Room**:
   - Click "Leave Room" to exit and return to the home page

## How it Works

The application uses WebRTC for direct peer-to-peer connections between participants:

1. When you join a room, a connection is established with the Firebase Realtime Database
2. Firebase helps coordinate the initial connection between peers (signaling)
3. WebRTC peers exchange offers and answers to establish media connections
4. ICE candidates are gathered and exchanged to find the optimal connection path
5. Once connected, video streams flow directly between participants without going through a server
6. This provides low-latency, high-quality screen sharing with good scalability

## Browser Compatibility

This application works best in modern browsers with WebRTC support:

- Google Chrome (recommended)
- Firefox
- Microsoft Edge
- Safari (may have limited functionality with WebRTC)

## Development

To contribute to the project:

1. Make sure you have Node.js and npm installed
2. Fork and clone the repository
3. Install dependencies with `npm install`
4. Start the development environment with `npm run dev`
5. Use the following npm scripts:
   - `npm run build` - Create production build
   - `npm run typecheck` - Check TypeScript types
   - `npm run format` - Format code with Prettier
   - `npm run format:check` - Check formatting without making changes
   - `npm run lint` - Lint code with ESLint
   - `npm run lint:fix` - Automatically fix linting issues
   - `npm run lint-format` - Run both linting and formatting fixes

## License

This project is licensed under the MIT License.

## Acknowledgments

- [WebRTC](https://webrtc.org/) for the real-time communication technology
- [Firebase](https://firebase.google.com/) for signaling and realtime database functionality
- [Tailwind CSS](https://tailwindcss.com/) for the styling framework
- [Lucide Icons](https://lucide.dev/) for the beautiful icons
- [Vite](https://vitejs.dev/) for the lightning-fast development experience

## Deployment

### Deploying to Netlify

To deploy this application to Netlify:

1. Create a Netlify account and connect your GitHub repository

2. Configure the following build settings:
   - Build command: `npm run build`
   - Publish directory: `dist`

3. Set up your environment variables:
   - Add all your Firebase environment variables in the Netlify UI under "Site settings" > "Environment variables"
   - Make sure to include all variables from your `.env` file

4. Troubleshooting common deployment issues:
   
   If you encounter an error like "Deploy directory 'dist' does not exist", ensure:
   
   - Your `package.json` build script is correctly configured to output to the `dist` directory
   - There are no TypeScript or other errors preventing the build from completing
   - Create a `netlify.toml` file in your root directory with:

   ```toml
   [build]
     command = "npm run build"
     publish = "dist"

   [[redirects]]
     from = "/*"
     to = "/index.html"
     status = 200
   ```

   - The redirect rule ensures proper routing for single-page applications

5. Deploy your site:
   - If using Netlify CLI: `netlify deploy --prod`
   - Or use the Netlify web UI to trigger a deployment

Remember that for WebRTC to work properly, your site should be served over HTTPS, which Netlify provides by default.
