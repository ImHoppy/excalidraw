import { createServer } from "http";

import express from "express";
import cors from "cors";
import { Server as SocketIOServer } from "socket.io";
import { v4 as uuidv4 } from "uuid";

const app = express();
const server = createServer(app);
const PORT = 8080;
const FRONTEND_URL = "http://localhost:3000";

// Socket.IO setup
const io = new SocketIOServer(server, {
  cors: {
    origin: ["http://localhost:3000"],
    methods: ["GET", "POST"],
    credentials: true,
  },
});

// Middleware
app.use(
  cors({
    origin: ["http://localhost:3000"],
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
    credentials: true,
  }),
);
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// In-memory storage
interface SceneData {
  id: string;
  data: any;
  createdAt: Date;
  updatedAt: Date;
}

interface FileData {
  id: string;
  data: string; // base64 or file content
  mimeType: string;
  createdAt: Date;
}

const scenes = new Map<string, SceneData>();
const files = new Map<string, FileData>();

// Room and user management for real-time collaboration
interface RoomUser {
  socketId: string;
  username?: string;
  isIdle?: boolean;
}

const rooms = new Map<string, Set<string>>(); // roomId -> Set of socketIds
const users = new Map<string, RoomUser>(); // socketId -> user info

function create_scene(sceneData?: any): {
  success: boolean;
  scene?: { id: string; createdAt: Date };
} {
  try {
    const id = uuidv4();
    const now = new Date();

    const scene: SceneData = {
      id,
      data: sceneData ? sceneData : {},
      createdAt: now,
      updatedAt: now,
    };

    scenes.set(id, scene);
    const createdScene = { id: scene.id, createdAt: scene.createdAt, data: {} };

    console.log(`Scene ${id} created via create_scene at ${now.toISOString()}`);
    return {
      success: true,
      scene: createdScene,
    };
  } catch (error) {
    console.error(
      `Failed to create scene: ${
        error instanceof Error ? error.message : "Unknown error"
      }`,
    );
  }

  return {
    success: false,
  };
}

// Socket.IO event handlers
io.on("connection", (socket) => {
  console.log(`User connected: ${socket.id}`);

  // Emit init-room immediately when user connects
  socket.emit("init-room");

  socket.on("join-room", (roomId: string) => {
    console.log(`User ${socket.id} joining room ${roomId}`);

    // Leave previous rooms
    socket.rooms.forEach((room) => {
      if (room !== socket.id) {
        socket.leave(room);
        const roomUsers = rooms.get(room);
        if (roomUsers) {
          roomUsers.delete(socket.id);
          if (roomUsers.size === 0) {
            rooms.delete(room);
          } else {
            // Notify remaining users
            socket.to(room).emit("room-user-change", Array.from(roomUsers));
          }
        }
      }
    });

    // Join new room
    socket.join(roomId);

    if (!rooms.has(roomId)) {
      rooms.set(roomId, new Set());
    }
    rooms.get(roomId)!.add(socket.id);

    // Store user info
    users.set(socket.id, { socketId: socket.id });

    // Notify room about user change
    const roomUsers = Array.from(rooms.get(roomId) || []);
    io.to(roomId).emit("room-user-change", roomUsers);

    // Notify existing users about new user
    socket.to(roomId).emit("new-user", socket.id);
  });

  socket.on("server-broadcast", (roomId: string, data: any) => {
    // Broadcast raw JSON data to all other users in the room
    socket.to(roomId).emit("client-broadcast", data);
  });

  socket.on("server-volatile-broadcast", (roomId: string, data: any) => {
    // Broadcast volatile updates (mouse movements, etc.) as raw JSON
    socket.to(roomId).volatile.emit("client-volatile", data);
  });

  socket.on("user-follow-change", (payload: any) => {
    // Broadcast user follow events
    socket.broadcast.emit("user-follow-change", payload);
  });

  socket.on("disconnect", () => {
    console.log(`User disconnected: ${socket.id}`);

    // Remove user from all rooms
    socket.rooms.forEach((roomId) => {
      if (roomId !== socket.id) {
        const roomUsers = rooms.get(roomId);
        if (roomUsers) {
          roomUsers.delete(socket.id);
          if (roomUsers.size === 0) {
            rooms.delete(roomId);
          } else {
            // Notify remaining users
            socket.to(roomId).emit("room-user-change", Array.from(roomUsers));
          }
        }
      }
    });

    // Remove user info
    users.delete(socket.id);
  });
});

// Scene endpoints
app.get("/api/scenes/:id", (req, res) => {
  const { id } = req.params;
  const scene = scenes.get(id);

  if (!scene) {
    // Return 404 for non-existent scenes - let the frontend handle it
    const { success, scene } = create_scene({});
    if (success && scene) {
      return res.json(scene);
    }
    return res.status(500).json({ error: "Failed to create new scene" });
  }

  // Return the scene data in the format expected by the frontend
  res.json(scene.data);
});

app.put("/api/scenes/:id", (req, res) => {
  const { id } = req.params;
  const { data } = req.body;

  if (!data) {
    return res.status(400).json({ error: "Scene data is required" });
  }

  const existingScene = scenes.get(id);
  const now = new Date();

  const scene: SceneData = {
    id,
    data,
    createdAt: existingScene?.createdAt || now,
    updatedAt: now,
  };

  scenes.set(id, scene);

  console.log(`Scene ${id} saved at ${now.toISOString()}`);

  res.json({
    id: scene.id,
    success: true,
    updatedAt: scene.updatedAt,
  });
});

app.post("/api/scenes", (req, res) => {
  const { data } = req.body;

  if (!data) {
    return res.status(400).json({ error: "Scene data is required" });
  }

  const id = uuidv4();
  const now = new Date();

  const scene: SceneData = {
    id,
    data,
    createdAt: now,
    updatedAt: now,
  };

  scenes.set(id, scene);

  console.log(`New scene ${id} created at ${now.toISOString()}`);

  res.json({
    id: scene.id,
    success: true,
    createdAt: scene.createdAt,
  });
});

// File endpoints
app.post("/api/files", (req, res) => {
  const { data, mimeType } = req.body;

  if (!data) {
    return res.status(400).json({ error: "File data is required" });
  }

  const id = uuidv4();
  const now = new Date();

  const file: FileData = {
    id,
    data,
    mimeType: mimeType || "application/octet-stream",
    createdAt: now,
  };

  files.set(id, file);

  console.log(`File ${id} uploaded at ${now.toISOString()}`);

  res.json({
    id: file.id,
    success: true,
    url: `http://localhost:${PORT}/api/files/${id}`,
  });
});

app.get("/api/files/:id", (req, res) => {
  const { id } = req.params;
  const file = files.get(id);

  if (!file) {
    return res.status(404).json({ error: "File not found" });
  }

  // Set appropriate headers
  res.set("Content-Type", file.mimeType);

  // If it's base64 data, decode it
  if (file.data.startsWith("data:")) {
    const base64Data = file.data.split(",")[1];
    const buffer = Buffer.from(base64Data, "base64");
    res.send(buffer);
  } else {
    res.send(file.data);
  }
});

// Health check endpoint
app.get("/api/health", (req, res) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    scenes: scenes.size,
    files: files.size,
  });
});

// List all scenes (for debugging)
app.get("/api/scenes", (req, res) => {
  const sceneList = Array.from(scenes.values()).map((scene) => ({
    id: scene.id,
    createdAt: scene.createdAt,
    updatedAt: scene.updatedAt,
    dataSize: JSON.stringify(scene.data).length,
  }));

  res.json({
    scenes: sceneList,
    total: scenes.size,
  });
});

// Delete scene endpoint
app.delete("/api/scenes/:id", (req, res) => {
  const { id } = req.params;
  const deleted = scenes.delete(id);

  if (!deleted) {
    return res.status(404).json({ error: "Scene not found" });
  }

  console.log(`Scene ${id} deleted`);

  res.json({
    success: true,
    message: "Scene deleted successfully",
  });
});

// Redirect all non-API routes to frontend
app.use((req, res, next) => {
  if (!req.path.startsWith("/api")) {
    return res.redirect(`${FRONTEND_URL}${req.originalUrl}`);
  }
  next();
});

// Error handling middleware
app.use(
  (
    err: any,
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    console.error("Server error:", err);
    res.status(500).json({
      error: "Internal server error",
      message: err.message,
    });
  },
);

// 404 handler for API routes only
app.use((req, res) => {
  if (req.path.startsWith("/api")) {
    res.status(404).json({
      error: "API endpoint not found",
      path: req.path,
    });
  } else {
    // Fallback redirect if somehow we get here
    res.redirect(`${FRONTEND_URL}${req.originalUrl}`);
  }
});

server.listen(PORT, () => {
  console.log(`🚀 Excalidraw API Server running on http://localhost:${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/api/health`);
  console.log(`📝 Scenes endpoint: http://localhost:${PORT}/api/scenes`);
  console.log(`📁 Files endpoint: http://localhost:${PORT}/api/files`);
  console.log(`🔌 Socket.IO enabled for real-time collaboration`);
});

export default app;
