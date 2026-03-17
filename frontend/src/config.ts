// Keep API/WS calls path-based so requests stay same-origin through Vite locally
// and through the Nginx edge on Paperspace.
export const API_BASE_URL = import.meta.env.BASE_URL.replace(/\/$/, "");
