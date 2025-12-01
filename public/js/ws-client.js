// ===================================
// WEBSOCKET CLIENT HELPER
// ===================================
// File ini berisi helper functions untuk WebSocket
// yang bisa di-reuse di halaman manapun

// Global WebSocket connection
let globalWS = null;
let globalClientId = null;

// Initialize WebSocket connection
function initGlobalWebSocket(onConnected, onMessage, onDisconnected) {
  globalWS = new WebSocket('ws://localhost:3001');
  
  globalWS.onopen = () => {
    console.log('✅ [ws-client] WebSocket connected');
    if (onConnected) onConnected();
  };
  
  globalWS.onmessage = (event) => {
    try {
      const { type, data } = JSON.parse(event.data);
      
      // Save client ID
      if (type === 'connected') {
        globalClientId = data.clientId;
        console.log('🆔 [ws-client] Client ID:', globalClientId);
      }
      
      if (onMessage) onMessage(type, data);
      
    } catch (error) {
      console.error('❌ [ws-client] Error parsing message:', error);
    }
  };
  
  globalWS.onclose = () => {
    console.log('❌ [ws-client] WebSocket disconnected');
    if (onDisconnected) onDisconnected();
    
    // Auto reconnect
    setTimeout(() => {
      console.log('🔄 [ws-client] Reconnecting...');
      initGlobalWebSocket(onConnected, onMessage, onDisconnected);
    }, 3000);
  };
  
  globalWS.onerror = (error) => {
    console.error('❌ [ws-client] WebSocket error:', error);
  };
}

// Send message via global WebSocket
function sendGlobalMessage(type, data) {
  if (globalWS && globalWS.readyState === WebSocket.OPEN) {
    globalWS.send(JSON.stringify({ type, data }));
    return true;
  } else {
    console.error('❌ [ws-client] WebSocket not connected');
    return false;
  }
}

// Get client ID
function getGlobalClientId() {
  return globalClientId;
}

// Check if connected
function isGlobalWSConnected() {
  return globalWS && globalWS.readyState === WebSocket.OPEN;
}

// Close connection
function closeGlobalWS() {
  if (globalWS) {
    globalWS.close();
    globalWS = null;
    globalClientId = null;
  }
}