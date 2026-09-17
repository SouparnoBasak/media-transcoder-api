import { FastifyInstance } from "fastify";
import { WebSocket } from "ws";
import Redis from "ioredis";

const userSockets = new Map<string, Set<WebSocket>>();

export function setupRealtimeEvents(app: FastifyInstance) {
    // Separate Redis connection for subscribing
    const sub = new Redis(
        process.env.REDIS_URL || "redis://localhost:6379"
    );

    sub.subscribe("file:events");

    sub.on("message", (channel, message) => {
        if (channel !== "file:events") 
            return;

        try {
            const event = JSON.parse(message);

            const sockets = userSockets.get(event.userId);

            if (!sockets) return;

            sockets.forEach((socket) => {
                if (socket.readyState === WebSocket.OPEN) {
                    socket.send(JSON.stringify(event));
                }
            });
        } catch (err) {
            console.error("Failed to process Redis event:", err);
        }
    });

    // WebSocket endpoint
    app.get(
        "/api/v1/ws",
        { websocket: true },
        (socket, req) => {
            const token = (req.query as { token?: string }).token;

            if (!token) {
                socket.close(1008, "Token required");
                return;
            }

            try {
                const decoded = app.jwt.verify<{
                    userId: string;
                    email?: string;
                }>(token);

                const userId = decoded.userId;

                // Create socket set for this user if necessary
                if (!userSockets.has(userId)) {
                    userSockets.set(userId, new Set());
                }

                const sockets = userSockets.get(userId)!;

                sockets.add(socket);

                console.log(
                    `WebSocket connected: user ${userId}`
                );

                // Remove socket when connection closes
                socket.on("close", () => {
                    sockets.delete(socket);

                    if (sockets.size === 0) {
                        userSockets.delete(userId);
                    }

                    console.log(
                        `WebSocket disconnected: user ${userId}`
                    );
                });

            } catch (err) {
                console.log("Invalid WebSocket JWT");

                socket.close(1008, "Invalid token");
            }
        }
    );
}