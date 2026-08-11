import { onRequestPost, onRequestGet } from '../functions/api/lead.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/lead') {
      if (request.method === 'POST') return onRequestPost({ request, env, ctx });
      if (request.method === 'GET') return onRequestGet({ request, env, ctx });
    }

    return env.ASSETS.fetch(request);
  }
};
