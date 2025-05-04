// server.js
import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { fileURLToPath } from "url";
import path from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = createServer(app);

// Create Socket.IO server with CORS configuration
const io = new Server(server, {
  cors: {
    origin: process.env.NODE_ENV === 'development' 
      ? 'http://localhost:5173' 
      : true,
    methods: ["GET", "POST"],
    credentials: true
  },
  pingTimeout: 60000, // 60 seconds
  pingInterval: 25000, // 25 seconds
});

// Add CORS headers for development
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

// Serve static files - main app files
app.use('/app', express.static(path.join(__dirname, "public", "app")));

// Serve other static files
app.use(express.static(path.join(__dirname, "public")));

// Store active rooms and connections
const rooms = new Map();

// Socket.IO connection handler
io.on("connection", (socket) => {
  console.log(`New connection: ${socket.id}`);
  let roomId = null;
  let userId = null;
  let userRole = null;

  // Join room event
  socket.on("join", (data) => {
    roomId = data.room;
    userId = data.userId;
    userRole = data.role;
    
    console.log(`User ${userId} (${socket.id}) joining room ${roomId} as ${userRole}`);
    
    // Create room if it doesn't exist
    if (!rooms.has(roomId)) {
      rooms.set(roomId, new Map());
      console.log(`Created new room: ${roomId}`);
    }
    
    // Add user to room
    rooms.get(roomId).set(userId, {
      socketId: socket.id,
      role: userRole, // 'sharer' or 'viewer'
    });
    
    // Join Socket.IO room
    socket.join(roomId);
    
    console.log(`Room ${roomId} has ${rooms.get(roomId).size} participants`);
    
    // Send room status to all participants
    const roomInfo = {
      participants: Array.from(rooms.get(roomId).keys()),
      hasSharer: Array.from(rooms.get(roomId).values()).some(p => p.role === 'sharer')
    };
    
    io.to(roomId).emit("room-info", roomInfo);
  });
  
  // Signal event for WebRTC
  socket.on("signal", (data) => {
    if (!roomId || !userId) return;
    
    console.log(`Signal from ${userId} to ${data.target || 'all'}`);
    
    if (data.target) {
      // Get target socket ID
      const targetUser = rooms.get(roomId)?.get(data.target);
      if (targetUser) {
        // Send to specific user
        const signalData = { ...data, from: userId };
        delete signalData.target;
        io.to(targetUser.socketId).emit("signal", signalData);
      }
    } else {
      // Broadcast to room (excluding sender)
      socket.to(roomId).emit("signal", {
        ...data,
        from: userId
      });
    }
  });
  
  // Handle disconnection
  socket.on("disconnect", (reason) => {
    console.log(`User disconnected: ${socket.id}, reason: ${reason}`);
    
    if (roomId && userId) {
      // Remove user from room
      const room = rooms.get(roomId);
      if (room) {
        room.delete(userId);
        console.log(`User ${userId} left room ${roomId}`);
        
        // Delete room if empty
        if (room.size === 0) {
          rooms.delete(roomId);
          console.log(`Room ${roomId} is now empty and deleted`);
        } else {
          console.log(`Room ${roomId} has ${room.size} participants remaining`);
          
          // Notify remaining participants
          const roomInfo = {
            participants: Array.from(room.keys()),
            hasSharer: Array.from(room.values()).some(p => p.role === 'sharer')
          };
          
          io.to(roomId).emit("room-info", roomInfo);
        }
      }
    }
  });
});

// Handle all routes for SPA
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () =>
  console.log(`Server running at http://localhost:${PORT}`)
);
