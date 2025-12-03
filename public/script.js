// public/script.js
class FacebookMessenger {
    constructor() {
        this.socket = null;
        this.userId = null;
        this.tasks = new Map();
        this.connectSocket();
        this.loadTasks();
        this.setupEventListeners();
    }

    connectSocket() {
        // Generate user ID if not exists
        this.userId = localStorage.getItem('userId') || `user_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        localStorage.setItem('userId', this.userId);
        
        this.socket = io({
            query: { userId: this.userId }
        });

        this.socket.on('connect', () => {
            this.log('🔌 Connected to server', 'info');
        });

        this.socket.on('log', (message) => {
            this.addLog(message);
        });

        this.socket.on('taskProgress', (data) => {
            this.updateTaskProgress(data);
        });

        this.socket.on('disconnect', () => {
            this.log('🔌 Disconnected from server', 'warning');
        });
    }

    async loadTasks() {
        try {
            const response = await fetch('/api/tasks');
            const data = await response.json();
            this.tasks = new Map(data.tasks.map(task => [task.id, task]));
            this.updateTasksList();
            this.updateStats();
        } catch (error) {
            console.error('Error loading tasks:', error);
        }
    }

    async startTask() {
        const cookiesText = document.getElementById('cookiesText').value;
        const messagesText = document.getElementById('messagesText').value;
        const conversationsText = document.getElementById('conversationsText').value;
        const batchCount = document.getElementById('batchCount').value;
        const batchDelay = document.getElementById('batchDelay').value;
        const timeDelay = document.getElementById('timeDelay').value;

        // Check file inputs
        const cookiesFile = document.getElementById('cookiesFile').files[0];
        const messagesFile = document.getElementById('messagesFile').files[0];
        const conversationsFile = document.getElementById('conversationsFile').files[0];

        const formData = new FormData();
        formData.append('cookies_text', cookiesText);
        formData.append('messages_text', messagesText);
        formData.append('conversations_text', conversationsText);
        formData.append('batch_count', batchCount);
        formData.append('batch_delay', batchDelay);
        formData.append('time_delay', timeDelay);

        if (cookiesFile) formData.append('cookies_file', cookiesFile);
        if (messagesFile) formData.append('messages_file', messagesFile);
        if (conversationsFile) formData.append('conversations_file', conversationsFile);

        try {
            const response = await fetch('/api/start', {
                method: 'POST',
                body: formData
            });

            const data = await response.json();
            
            if (data.success) {
                this.log(`🚀 Task started: ${data.taskId}`, 'success');
                document.getElementById('currentTaskId').textContent = data.taskId;
                await this.loadTasks();
            } else {
                this.log(`❌ Failed to start task: ${data.message}`, 'error');
            }
        } catch (error) {
            this.log(`💥 Error starting task: ${error.message}`, 'error');
        }
    }

    async stopTask(taskId) {
        try {
            const response = await fetch(`/api/stop/${taskId}`, {
                method: 'POST'
            });
            
            const data = await response.json();
            
            if (data.success) {
                this.log(`🛑 Task stopped: ${taskId}`, 'warning');
                await this.loadTasks();
            }
        } catch (error) {
            this.log(`💥 Error stopping task: ${error.message}`, 'error');
        }
    }

    addLog(message, type = 'info') {
        const logsContainer = document.getElementById('logsContainer');
        const logEntry = document.createElement('div');
        logEntry.className = `log-entry ${type}`;
        
        let icon = 'info-circle';
        if (type === 'success') icon = 'check-circle';
        if (type === 'error') icon = 'exclamation-circle';
        if (type === 'warning') icon = 'exclamation-triangle';
        
        logEntry.innerHTML = `
            <i class="fas fa-${icon}"></i> ${message}
        `;
        
        logsContainer.appendChild(logEntry);
        logsContainer.scrollTop = logsContainer.scrollHeight;
        
        // Keep only last 100 logs
        const logs = logsContainer.querySelectorAll('.log-entry');
        if (logs.length > 100) {
            logs[0].remove();
        }
    }

    log(message, type = 'info') {
        const timestamp = new Date().toLocaleTimeString();
        this.addLog(`[${timestamp}] ${message}`, type);
    }

    updateTaskProgress(data) {
        const task = this.tasks.get(data.taskId);
        if (task) {
            Object.assign(task, data);
            this.updateTasksList();
            this.updateStats();
        }
    }

    updateTasksList() {
        const tasksList = document.getElementById('tasksList');
        tasksList.innerHTML = '';
        
        if (this.tasks.size === 0) {
            tasksList.innerHTML = `
                <div style="text-align: center; padding: 20px; color: #6c757d;">
                    <i class="fas fa-tasks fa-2x" style="margin-bottom: 10px;"></i>
                    <p>No tasks yet. Start your first task above.</p>
                </div>
            `;
            return;
        }

        Array.from(this.tasks.values()).forEach(task => {
            const taskElement = document.createElement('div');
            taskElement.className = `task-item ${task.status}`;
            
            const progressPercent = task.progress || 0;
            
            taskElement.innerHTML = `
                <div class="task-header">
                    <div class="task-id">${task.id}</div>
                    <div class="task-status status-${task.status}">${task.status.toUpperCase()}</div>
                </div>
                
                <div class="progress-bar">
                    <div class="progress-fill" style="width: ${progressPercent}%"></div>
                </div>
                
                <div class="task-stats">
                    <span><i class="fas fa-check"></i> Sent: ${task.sent || 0}</span>
                    <span><i class="fas fa-times"></i> Failed: ${task.failed || 0}</span>
                    <span><i class="fas fa-chart-bar"></i> Total: ${task.total || 0}</span>
                    <span><i class="fas fa-percentage"></i> ${progressPercent}%</span>
                </div>
                
                <div style="margin-top: 10px;">
                    ${task.status === 'running' ? `
                        <button onclick="messenger.stopTask('${task.id}')" class="btn btn-danger" style="padding: 5px 15px; font-size: 12px;">
                            <i class="fas fa-stop"></i> Stop
                        </button>
                    ` : ''}
                    <small style="color: #6c757d; margin-left: 10px;">
                        Started: ${new Date(task.startTime).toLocaleTimeString()}
                    </small>
                </div>
            `;
            
            tasksList.appendChild(taskElement);
        });
    }

    updateStats() {
        const tasks = Array.from(this.tasks.values());
        
        document.getElementById('totalTasks').textContent = tasks.length;
        document.getElementById('runningTasks').textContent = 
            tasks.filter(t => t.status === 'running').length;
        document.getElementById('completedTasks').textContent = 
            tasks.filter(t => t.status === 'completed').length;
    }

    clearLogs() {
        document.getElementById('logsContainer').innerHTML = `
            <div class="log-entry">
                <i class="fas fa-info-circle"></i> Logs cleared
            </div>
        `;
    }

    setupEventListeners() {
        // File input change events
        document.getElementById('cookiesFile').addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (file) {
                const text = await file.text();
                document.getElementById('cookiesText').value = text;
                this.log(`📁 Loaded cookies from: ${file.name}`, 'success');
            }
        });

        document.getElementById('messagesFile').addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (file) {
                const text = await file.text();
                document.getElementById('messagesText').value = text;
                this.log(`📁 Loaded messages from: ${file.name}`, 'success');
            }
        });

        document.getElementById('conversationsFile').addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (file) {
                const text = await file.text();
                document.getElementById('conversationsText').value = text;
                this.log(`📁 Loaded conversations from: ${file.name}`, 'success');
            }
        });

        // Auto-refresh tasks every 10 seconds
        setInterval(() => this.loadTasks(), 10000);
    }
}

// Modal functions
function showModal(type) {
    document.getElementById(`${type}Modal`).style.display = 'flex';
}

function hideModal(type) {
    document.getElementById(`${type}Modal`).style.display = 'none';
}

function saveCookies() {
    hideModal('cookies');
    window.messenger.log('✅ Cookies saved', 'success');
}

function saveMessages() {
    hideModal('messages');
    window.messenger.log('✅ Messages saved', 'success');
}

// Global functions
function startTask() {
    window.messenger.startTask();
}

function clearLogs() {
    window.messenger.clearLogs();
}

// Initialize app
document.addEventListener('DOMContentLoaded', () => {
    window.messenger = new FacebookMessenger();
});
