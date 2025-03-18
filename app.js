const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

let currentQuestion = {
    text: "",
    options: ["", "", "", ""],
};
let timerValue = 30;
let currentTimerValue = null;
let timerStartTime = null;
let timerPaused = true;
let timerPausedAt = null;
let timerMaxValue = 30;
let timerStarted = false;
let highlightedOption = { index: null, type: null };
let lastBroadcastTime = 0;
let currentScreen = "logo";

io.on("connection", (socket) => {
    if (currentQuestion) {
        socket.emit("display-question", currentQuestion);
        if (currentQuestion.showOptions) {
            socket.emit("show-options");
            updateTimerForClient(socket, false);
        }
        
        if (highlightedOption.index !== null) {
            if (highlightedOption.type === "selected") {
                socket.emit("highlight-answer", highlightedOption.index);
            } else if (highlightedOption.type === "correct") {
                socket.emit("mark-correct", highlightedOption.index);
            } else if (highlightedOption.type === "wrong") {
                socket.emit("mark-wrong", highlightedOption.index);
            }
        }
    }

    socket.emit("change-screen", currentScreen);
    
    socket.emit("timer-state", { 
        state: timerStarted ? (timerPaused ? "paused" : "running") : "stopped" 
    });

    socket.on("question-update", (data) => {
        if (!data.text || !data.text.trim() || 
            !data.options || data.options.some(opt => !opt || !opt.trim())) {
            return;
        }

        timerMaxValue = timerValue;
        currentTimerValue = timerValue;
        
        if (timerStarted) {
            if (currentQuestion) {
                currentQuestion = { 
                    ...currentQuestion,
                    text: data.text,
                    options: data.options
                };
            }
        } else {
            timerPaused = true;
            timerPausedAt = null;
            timerStartTime = null;
            timerStarted = false;
            highlightedOption = { index: null, type: null };
            currentQuestion = { 
                ...data, 
                timer: timerValue,
                maxTimer: timerMaxValue,
                showOptions: false
            };
        }
        
        io.emit("display-question", currentQuestion);
        io.emit("timer-state", { state: timerStarted ? (timerPaused ? "paused" : "running") : "stopped" });
    });

    socket.on("show-options", () => {
        if (!currentQuestion || timerStarted) return;
        
        currentQuestion.showOptions = true;
        timerPaused = false;
        timerStartTime = Date.now();
        currentTimerValue = timerValue;
        timerStarted = true;
        
        io.emit("show-options");
        io.emit("update-timer", {
            current: currentTimerValue,
            max: timerMaxValue,
            audioTrigger: true,
            startPosition: 59 - timerValue
        });
        io.emit("timer-state", { state: "running" });

        lastBroadcastTime = Date.now();
    });

    socket.on("pick-answer", (index) => {
        if (currentQuestion && index >= 0 && index < currentQuestion.options.length) {
            highlightedOption = { index, type: "selected" };
            io.emit("highlight-answer", index);
            io.emit("trigger-audio", "lock");
            pauseTimer(false);
        }
    });

    socket.on("mark-correct", (index) => {
        if (currentQuestion && index >= 0 && index < currentQuestion.options.length) {
            highlightedOption = { index, type: "correct" };
            io.emit("mark-correct", index);
            io.emit("trigger-audio", "correct");
        }
    });

    socket.on("mark-wrong", (index) => {
        if (currentQuestion && index >= 0 && index < currentQuestion.options.length) {
            highlightedOption = { index, type: "wrong" };
            io.emit("mark-wrong", index);
            io.emit("trigger-audio", "wrong");
        }
    });

    socket.on("reset-timer", () => {
        if (timerStarted) return;

        currentTimerValue = timerValue;
        io.emit("update-timer", {
            current: currentTimerValue,
            max: timerMaxValue,
            audioTrigger: false
        });
    });

    socket.on("change-timer", (value) => {
        if (timerStarted) return;

        timerValue = value;
        timerMaxValue = value;
        currentTimerValue = value;
        io.emit("update-timer", {
            current: currentTimerValue,
            max: timerMaxValue,
            audioTrigger: false
        });
    });

    socket.on("freeze-timer", () => {
        pauseTimer(false);
    });

    socket.on("remove-question", () => {
        currentQuestion = {
            text: "",
            options: ["", "", "", ""],
        };
        timerPaused = true;
        timerStartTime = null;
        timerPausedAt = null;
        timerStarted = false;
        highlightedOption = { index: null, type: null };
        io.emit("clear-question");
        io.emit("timer-state", { state: "stopped" });
    });

    socket.on("play-audio", (type) => {
        io.emit("trigger-audio", type);
    });

    socket.on("get-timer", () => {
        updateTimerForClient(socket, false);
        socket.emit("timer-state", { 
            state: timerStarted ? (timerPaused ? "paused" : "running") : "stopped" 
        });
    });

    socket.on("pause-timer", () => {
        if (!timerStarted || timerPaused) return;
        pauseTimer(true);
    });

    socket.on("continue-timer", () => {
        if (!timerStarted || !timerPaused) return;

        if (timerPausedAt !== null) {
            timerStartTime = Date.now() - (timerPausedAt - (timerStartTime || 0));
            timerPaused = false;
            timerPausedAt = null;
            
            const elapsedSeconds = Math.floor((Date.now() - timerStartTime) / 1000);
            const remainingTime = Math.max(0, timerValue - elapsedSeconds);
            const audioOffset = 59 - remainingTime;
            
            io.emit("unfreeze-timer", true, audioOffset);
            updateTimerForAllClients(true, audioOffset);
            io.emit("timer-state", { state: "running" });
        }
    });
    
    socket.on("set-screen", (screen) => {
        currentScreen = screen;
        io.emit("change-screen", screen);
    });
});

function pauseTimer(triggerAudio = false) {
    if (!timerPaused && timerStarted) {
        timerPausedAt = Date.now();
        timerPaused = true;
        if (timerStartTime) {
            currentTimerValue = Math.max(0, timerValue - Math.floor((timerPausedAt - timerStartTime) / 1000));
        }
        io.emit("freeze-timer", triggerAudio);
        io.emit("timer-state", { state: "paused" });
    }
}

function updateTimerForClient(socket, triggerAudio = false, audioOffset = 0) {
    if (currentTimerValue === "unlimited") {
        socket.emit("update-timer", {
            current: "unlimited",
            max: "unlimited",
            audioTrigger: triggerAudio
        });
        socket.emit("current-timer", {
            current: "unlimited",
            max: "unlimited"
        });
        return;
    }

    if (timerPaused) {
        socket.emit("update-timer", {
            current: currentTimerValue,
            max: timerMaxValue,
            audioTrigger: triggerAudio,
            startPosition: audioOffset
        });
        socket.emit("current-timer", {
            current: currentTimerValue,
            max: timerMaxValue
        });
        socket.emit("freeze-timer", false);
    } else if (timerStartTime) {
        const elapsedSeconds = Math.floor((Date.now() - timerStartTime) / 1000);
        const remainingTime = Math.max(0, timerValue - elapsedSeconds);
        socket.emit("update-timer", {
            current: remainingTime,
            max: timerMaxValue,
            audioTrigger: triggerAudio,
            startPosition: audioOffset || (59 - remainingTime)
        });
        socket.emit("current-timer", {
            current: remainingTime,
            max: timerMaxValue
        });
        socket.emit("unfreeze-timer", false);
    }
}

function updateTimerForAllClients(triggerAudio = false, audioOffset = 0) {
    const now = Date.now();
    if (!triggerAudio && now - lastBroadcastTime < 950) {
        return;
    }
    
    lastBroadcastTime = now;
    
    io.sockets.sockets.forEach(socket => {
        updateTimerForClient(socket, triggerAudio, audioOffset);
    });
}

setInterval(() => {
    if (!timerPaused && timerStartTime) {
        updateTimerForAllClients(false);
    }
}, 1000);

module.exports = server;
