const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const winston = require("winston");
const { v4: uuidv4 } = require("uuid");
const os = require("os");

// Configure logging
const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    winston.format.printf(
      ({ timestamp, level, message }) =>
        `${timestamp} - ${level.toUpperCase()} - ${message}`
    )
  ),
  transports: [
    new winston.transports.File({
      filename: "chat_server.log",
      maxsize: 10 * 1024 * 1024,
      maxFiles: 5,
    }),
    new winston.transports.Console(),
  ],
});

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const rooms = new Map();

app.use(
  express.static(path.join(__dirname, "public"), {
    index: false,
    setHeaders: (res, path, stat) => {
      logger.info(`Serving static file: ${path}`);
    },
  })
);

app.get("/", (req, res) => {
  const filePath = path.join(__dirname, "public", "index.html");
  logger.info(`Serving index.html for request to / from ${req.ip}`);
  res.sendFile(filePath, (err) => {
    if (err) {
      logger.error(`Error serving index.html: ${err.message}`);
      res
        .status(404)
        .send(
          "Error: index.html not found. Please ensure the public directory contains index.html."
        );
    }
  });
});

io.on("connection", (socket) => {
  logger.info(`New connection from ${socket.id}`);
  socket.state = { step: "choice" };
  socket.emit("prompt", "Enter option (1 for host, 2 for connect): ");

  socket.on("response", (data) => {
    handleResponse(socket, data.trim());
  });

  socket.on("chat_message", (data) => {
    console.log(socket.state);
    console.log(data);

    if (socket.state && socket.state.step === "chat" && data) {
      const roomId = socket.state.roomId;
      const username = rooms.get(roomId)?.clients.get(socket.id);
      if (username && roomId) {
        io.to(roomId).emit("message", `[${username}] ${data}`);
        logger.info(`Message from ${username} in room ${roomId}: ${data}`);
      } else {
        socket.emit("error", "Not in a valid room or username not set.");
      }
    }
  });

  socket.on("quit", () => {
    const roomId = findRoomForSocket(socket.id);
    if (roomId) {
      const room = rooms.get(roomId);
      const username = room.clients.get(socket.id);
      if (username) {
        room.clients.delete(socket.id);
        logger.info(`Client ${username} quit explicitly from room ${roomId}`);
        io.to(roomId).emit("message", `*** ${username} left the chat ***`);
      }
    }
    socket.state = { step: "choice" };
    socket.disconnect(true);
  });

  socket.on("disconnect", () => {
    const roomId = findRoomForSocket(socket.id);
    if (roomId) {
      const room = rooms.get(roomId);
      const username = room.clients.get(socket.id);
      if (username) {
        room.clients.delete(socket.id);
        logger.info(`Client ${username} disconnected from room ${roomId}`);
        io.to(roomId).emit("message", `*** ${username} left the chat ***`);
        if (room.clients.size === 0) {
          rooms.delete(roomId);
          logger.info(`Room ${roomId} deleted (no clients remaining)`);
        }
      }
    }
    logger.info(`Closed connection for ${socket.id}`);
  });
});

function handleResponse(socket, data) {
  const state = socket.state || { step: "choice" };
  logger.info(`Handling response from ${socket.id} in state ${state.step}: ${data}`);

  if (state.step === "choice") {
    if (data === "1") {
      state.step = "host_type";
      socket.emit("prompt", "Make room [1] open or [2] private: ");
    } else if (data === "2") {
      state.step = "connect_room";
      socket.emit("prompt", "Enter room ID: ");
    } else {
      socket.emit("error", "Invalid option. Choose 1 or 2.");
      socket.emit("prompt", "Enter option (1 for host, 2 for connect): ");
    }
  } else if (state.step === "host_type") {
    if (data === "1") {
      const res = createRoom(socket, null);
      socket.state = res.state;
      socket.roomId = res.roomId;
      socket.emit("prompt", "Enter your username: ");
    } else if (data === "2") {
      state.step = "host_passkey";
      socket.emit("prompt", "Set a passkey: ");
    } else {
      socket.emit("error", "Invalid option. Choose 1 or 2.");
      socket.emit("prompt", "Make room [1] open or [2] private: ");
    }
  } else if (state.step === "host_passkey") {
    if (!data) {
      socket.emit("error", "Passkey cannot be empty.");
      socket.emit("prompt", "Set a passkey: ");
    } else {
      const res = createRoom(socket, data);
      socket.state = res.state;
      socket.roomId = res.roomId;
      socket.emit("prompt", "Enter your username: ");
    }
  } else if (state.step === "connect_room") {
    if (!rooms.has(data)) {
      socket.emit("error", "Room does not exist.");
      socket.emit("prompt", "Enter room ID: ");
    } else {
      state.roomId = data;
      const room = rooms.get(data);
      if (room.passkey) {
        state.step = "connect_passkey";
        socket.emit("prompt", "Enter passkey: ");
      } else {
        state.step = "username";
        socket.emit("prompt", "Enter your username: ");
      }
    }
  } else if (state.step === "connect_passkey") {
    const room = rooms.get(state.roomId);
    if (!room || data !== room.passkey) {
      socket.emit("error", "Invalid passkey.");
      socket.emit("prompt", "Enter passkey: ");
    } else {
      state.step = "username";
      socket.emit("prompt", "Enter your username: ");
    }
  } else if (state.step === "username") {
    if (!data) {
      socket.emit("error", "Username cannot be empty.");
      socket.emit("prompt", "Enter your username: ");
    } else {
      joinRoom(socket, state.roomId, data);
      state.step = "chat";
      socket.emit("message", "type and hit enter to send a message");
    }
  } else {
    socket.emit("error", "Invalid state. Please reconnect.");
    socket.state = { step: "choice" };
    socket.emit("prompt", "Enter option (1 for host, 2 for connect): ");
  }
  socket.state = state;
}

function createRoom(socket, passkey) {
  const roomId = uuidv4();
  rooms.set(roomId, { passkey, clients: new Map() });
  socket.state = { step: "username", roomId };
  socket.emit(
    "message",
    `Room created with ID: ${roomId}\nShare this ID with others to join${
      passkey ? " (passkey required)" : ""
    }.`
  );
  logger.info(`Room ${roomId} created${passkey ? " with passkey" : " (open)"}`);
  return { step: "username", roomId };
}

function joinRoom(socket, roomId, username) {
  const room = rooms.get(roomId);
  if (!room) {
    socket.emit("error", "Room no longer exists.");
    socket.state = { step: "choice" };
    socket.emit("prompt", "Enter option (1 for host, 2 for connect): ");
    return;
  }
  room.clients.set(socket.id, username);
  socket.join(roomId);
  socket.state = { step: "chat", roomId };
  io.to(roomId).emit("message", `*** ${username} joined the chat ***`);
  socket.emit("message", "Connection successful. Welcome to the chat!");
  logger.info(`Client ${username} joined room ${roomId}`);
}

function findRoomForSocket(socketId) {
  for (const [roomId, room] of rooms) {
    if (room.clients.has(socketId)) {
      return roomId;
    }
  }
  return null;
}

function getServerIp() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address;
      }
    }
  }
  return "localhost";
}

const PORT = 3000;
server.listen(PORT, () => {
  const ip = getServerIp();
  logger.info(`Server listening on http://${ip}:${PORT}`);
});

process.on("SIGINT", () => {
  logger.info("Shutting down server...");
  for (const roomId of rooms.keys()) {
    io.to(roomId).emit("message", "*** Server is shutting down ***");
  }
  io.close(() => {
    logger.info("Server closed");
    process.exit(0);
  });
});