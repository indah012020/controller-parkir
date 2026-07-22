const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');

const activeDevices = new Map();
let eventLogs = [];
const MAX_LOGS = 50;

// 1. HTTP Server menyajikan file index.html eksternal
const httpServer = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/index.html') {
        const filePath = path.join(__dirname, 'index.html');
        fs.readFile(filePath, (err, content) => {
            if (err) {
                res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('Gagal memuat file index.html');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(content);
        });
    } else {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
    }
});

const io = new Server(httpServer, {
    cors: { origin: "*" }
});

function recordLog(socketId, deviceId, eventName, eventData) {
    const logEntry = {
        time: new Date().toLocaleString(),
        deviceId: deviceId || 'Unknown',
        socketId: socketId,
        event: eventName,
        data: eventData || {}
    };

    console.log(`${logEntry.time} - [${eventName}] Device: ${logEntry.deviceId} | SocketID: ${socketId}`, eventData || '');

    eventLogs.unshift(logEntry);
    if (eventLogs.length > MAX_LOGS) eventLogs.pop();

    broadcastDashboardData();
}

function broadcastDashboardData() {
    const devicesArr = [];
    activeDevices.forEach((value, key) => {
        devicesArr.push({
            socketId: key,
            deviceId: value.deviceId || 'Menunggu ID...',
            connectedAt: value.isOnline ? value.connectedAt : '-',
            timestamp: value.timestamp,
            isOnline: value.isOnline
        });
    });

    io.emit('update_monitoring', {
        devices: devicesArr,
        logs: eventLogs
    });
}

// 2. Middleware Auth: Hanya validasi token jika request dari Device (ESP)
io.use((socket, next) => {
    const token = socket.handshake.headers.authorization;

    if (!token) {
        socket.isWebDashboard = true;
        return next();
    }

    if (token !== "1234567890") {
        console.log(new Date().toLocaleString() + " - Authentication error: Invalid token");
        return next(new Error("Authentication error: Invalid token"));
    }

    socket.user = token;
    next();
});

io.on('connection', (socket) => {
    const deviceId = socket.handshake.query.id;

    if (socket.isWebDashboard) {
        console.log(new Date().toLocaleString() + ' - Web Dashboard terhubung. SocketID:', socket.id);

        // Kirim initial state ke dashboard baru
        socket.emit('update_monitoring', {
            devices: Array.from(activeDevices.entries()).map(([k, v]) => ({
                socketId: k,
                deviceId: v.deviceId || 'Menunggu ID...',
                connectedAt: v.isOnline ? v.connectedAt : '-',
                timestamp: v.timestamp,
                isOnline: v.isOnline
            })),
            logs: eventLogs
        });

        socket.on('admin_command', ({ targetSocketId, action, ...extraData }) => {
            const targetSocket = io.sockets.sockets.get(targetSocketId);
            if (!targetSocket) return;

            const commandPayload = { action, ...extraData };
            targetSocket.emit('command', commandPayload);
            recordLog(targetSocketId, activeDevices.get(targetSocketId)?.deviceId || 'UNKNOWN', 'ADMIN_CMD', commandPayload);
        });

        // Event handler untuk clear logs dari dashboard
        socket.on('clear_logs', () => {
            eventLogs = [];
            console.log(new Date().toLocaleString() + ' - Event logs dibersihkan oleh admin.');
            broadcastDashboardData();
        });

        return;
    }

    // Logika Khusus Device (ESP)
    const connectTime = new Date();
    activeDevices.set(socket.id, {
        timestamp: Date.now(),
        connectedAt: connectTime.toLocaleString(),
        deviceId: deviceId,
        isOnline: true
    });
    checkAndUpdateDeviceId({ id: deviceId });

    recordLog(socket.id, deviceId, 'CONNECT', { message: 'Device terhubung' });

    const testingInterval = setInterval(() => {
        socket.emit('command', { "action": "playAudio", "folder": "02", "track": "02" });
        setTimeout(() => {
            socket.emit('command', { "action": "openGate" });
        }, 10000);
    }, 60000 * 60);

    socket.on('disconnect', () => {
        clearInterval(testingInterval);

        const devInfo = activeDevices.get(socket.id);
        const devId = devInfo ? devInfo.deviceId : deviceId;

        if (devInfo && devInfo.deviceId) {
            // Jika device sudah memiliki ID, ubah status menjadi offline
            devInfo.isOnline = false;
        } else {
            // Jika belum punya ID (masih "Menunggu ID..."), hapus dari Map
            activeDevices.delete(socket.id);
        }

        recordLog(socket.id, devId, 'DISCONNECT', { message: 'Device terputus' });
        broadcastDashboardData();
    });

    function checkAndUpdateDeviceId(data) {
        if (data && data.id) {
            const newDeviceId = data.id;

            // Cek apakah ada device lain (baik online/offline) yang menggunakan deviceId yang sama
            for (const [existingSocketId, devData] of activeDevices.entries()) {
                if (existingSocketId !== socket.id && devData.deviceId === newDeviceId) {
                    // Hapus data lama yang memiliki deviceId kembar/sama
                    activeDevices.delete(existingSocketId);
                }
            }

            // Update deviceId untuk koneksi socket yang sedang aktif ini
            const dev = activeDevices.get(socket.id);
            if (dev) {
                dev.deviceId = newDeviceId;
                dev.isOnline = true;
                broadcastDashboardData();
            }
        }
    }

    socket.on('message', (data) => {
        checkAndUpdateDeviceId(data);
        const dev = activeDevices.get(socket.id);
        recordLog(socket.id, dev ? dev.deviceId : 'UNKNOWN', 'message', data);
    });

    socket.on('help', (data) => {
        checkAndUpdateDeviceId(data);
        const dev = activeDevices.get(socket.id);
        recordLog(socket.id, dev ? dev.deviceId : 'UNKNOWN', 'help', data);
    });

    socket.on('start', (data) => {
        checkAndUpdateDeviceId(data);
        const dev = activeDevices.get(socket.id);
        const devId = dev ? dev.deviceId : 'UNKNOWN';

        recordLog(socket.id, devId, 'start', data);

        if (data.type === "button") {
            setTimeout(() => {
                socket.emit('command', { "action": "openGate" });
            }, 2000);
        } else {
            const registeredCardIds = ["706547715", "2071513441"];

            if (registeredCardIds.includes(data.card_id)) {
                setTimeout(() => {
                    socket.emit('command', { "action": "openGate" });
                }, 2000);
            } else {
                setTimeout(() => {
                    socket.emit('command', { "action": "playAudio", "folder": "02", "track": "04" });
                }, 2000);
            }
        }
    });

    socket.on('capture', (data) => {
        checkAndUpdateDeviceId(data);
        const dev = activeDevices.get(socket.id);
        const devId = dev ? dev.deviceId : 'UNKNOWN';

        recordLog(socket.id, devId, 'capture', data);

        if (data.vld1_kios || data.vld2_kios) {
            socket.emit('command', { "action": 'allowProcess' });
        } else {
            socket.emit('command', { "action": 'disallowProcess' });
        }
    });
});

httpServer.listen(9010, () => {
    console.log(new Date().toLocaleString() + ' - Server Testing & Monitoring berjalan di port 9010');
});