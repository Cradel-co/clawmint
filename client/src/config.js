const SERVER_HOST = import.meta.env.VITE_SERVER_URL || `${window.location.hostname}:3002`;
export const API_BASE = `http://${SERVER_HOST}`;
export const WS_URL = `ws://${SERVER_HOST}`;
