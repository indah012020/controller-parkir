const http = require('http');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');

let activeDevices = new Map();
let eventLogs = [];

// 1. HTTP Server menyajikan file index.html
const httpServer = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/index.html') {
        const filePath = path.join(__dirname, 'index.html');
        fs.readFile(filePath, (err, content) => {
            if (err) {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('Gagal memuat file index.html');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(content);
        });
    } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
    }
});

const io = new Server(httpServer, {
    cors: { origin: "*" }
});

function formatUptime(seconds) {
    const hrs = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    return `${hrs}j ${mins}m ${secs}d`;
}

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
    if (eventLogs.length > 50) eventLogs.pop();

    broadcastDashboardData();
}

function broadcastDashboardData() {
    const devicesArr = [];
    activeDevices.forEach((value, key) => {
        const uptimeSeconds = Math.floor((Date.now() - value.timestamp) / 1000);
        devicesArr.push({
            socketId: key,
            deviceId: value.deviceId || 'Menunggu ID...',
            connectedAt: value.connectedAt,
            uptimeFormatted: formatUptime(uptimeSeconds)
        });
    });

    io.emit('update_monitoring', {
        devices: devicesArr,
        logs: eventLogs
    });
}

setInterval(() => {
    if (activeDevices.size > 0) {
        broadcastDashboardData();
    }
}, 1000);

// 2. Middleware Auth: Hanya validasi token jika request dari Device (ESP)
io.use((socket, next) => {
    const token = socket.handshake.headers.authorization;
    
    // Jika tidak ada header authorization (berarti diakses dari browser/web dashboard)
    if (!token) {
        socket.isWebDashboard = true;
        return next();
    }

    // Validasi token khusus Device (ESP)
    if (token !== "1234567890") {
        console.log(new Date().toLocaleString() + " - Authentication error: Invalid token");
        return next(new Error("Authentication error: Invalid token"));
    }

    socket.user = token;
    next();
});

io.on('connection', (socket) => {
    // Jika koneksi dari Web Dashboard
    if (socket.isWebDashboard) {
        console.log(new Date().toLocaleString() + ' - Web Dashboard terhubung. SocketID:', socket.id);
        socket.emit('update_monitoring', {
            devices: Array.from(activeDevices.entries()).map(([k, v]) => ({
                socketId: k,
                deviceId: v.deviceId || 'Menunggu ID...',
                connectedAt: v.connectedAt,
                uptimeFormatted: formatUptime(Math.floor((Date.now() - v.timestamp) / 1000))
            })),
            logs: eventLogs
        });
        return;
    }

    // Logika Khusus Device (ESP)
    const connectTime = new Date();
    
    activeDevices.set(socket.id, {
        timestamp: Date.now(),
        connectedAt: connectTime.toLocaleString(),
        deviceId: null 
    });

    recordLog(socket.id, 'UNKNOWN', 'CONNECT', { message: 'Device terhubung' });

    const testingInterval = setInterval(function () {
        socket.emit('command', { "action": "playAudio", "folder": "02", "track": "02" });
        socket.emit('command', { "action": 'allowProcess' });
        setTimeout(function () {
            socket.emit('command', { "action": "openGate" });
            socket.emit('command', { "action": 'disallowProcess' });
        }, 5000);
    }, 60000);

    socket.on('disconnect', () => {
        clearInterval(testingInterval);
        const devInfo = activeDevices.get(socket.id);
        const devId = devInfo ? devInfo.deviceId : 'UNKNOWN';
        activeDevices.delete(socket.id);
        recordLog(socket.id, devId, 'DISCONNECT', { message: 'Device terputus' });
    });

    function checkAndUpdateDeviceId(data) {
        if (data && data.id) {
            const dev = activeDevices.get(socket.id);
            if (dev && !dev.deviceId) {
                dev.deviceId = data.id;
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
            setTimeout(function () {
                socket.emit('command', { "action": "openGate" });
            }, 2000);
        } else {
            const registeredCardIds = ["706547715", "2071513441"];

            if (registeredCardIds.findIndex(e => e === data.card_id) !== -1) {
                setTimeout(function () {
                    socket.emit('command', { "action": "openGate" });
                }, 2000);
            } else {
                setTimeout(function () {
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

httpServer.listen(8080, () => {
    console.log(new Date().toLocaleString() + ' - Server Testing & Monitoring berjalan di port 8080');
});