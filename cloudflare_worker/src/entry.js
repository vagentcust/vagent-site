export default {
  async fetch(request, env, ctx) {
    // CORS заголовки
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "86400",
    };

    // 1. Обработка OPTIONS (проверка CORS)
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);

    // --- РЕГИСТРАЦИЯ ---
    if (request.method === "POST" && url.pathname === "/register") {
      try {
        const body = await request.json();
        const { username, password } = body;

        if (!username || !password) {
          return new Response(JSON.stringify({ error: "Нужны логин и пароль" }), { status: 400, headers: corsHeaders });
        }

        const key = `user_${username}`;
        const existing = await env.VAGENT_USERS.get(key);
        if (existing) {
          return new Response(JSON.stringify({ error: "Логин занят" }), { status: 409, headers: corsHeaders });
        }

        const salt = crypto.getRandomValues(new Uint8Array(16)).join('');
        const msgUint8 = new TextEncoder().encode(password + salt);
        const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
        const storedValue = `${salt}$${hashHex}`;

        await env.VAGENT_USERS.put(key, storedValue);
        return new Response(JSON.stringify({ status: "ok", message: "Аккаунт создан" }), { headers: corsHeaders });

      } catch (e) {
        return new Response(JSON.stringify({ error: "Ошибка сервера: " + e.message }), { status: 500, headers: corsHeaders });
      }
    }

    // --- ВХОД ---
    if (request.method === "POST" && url.pathname === "/login") {
      try {
        const body = await request.json();
        const { username, password } = body;
        const key = `user_${username}`;
        const storedValue = await env.VAGENT_USERS.get(key);

        if (!storedValue) {
          return new Response(JSON.stringify({ error: "Пользователь не найден" }), { status: 404, headers: corsHeaders });
        }

        const [salt, originalHash] = storedValue.split('$');
        const msgUint8 = new TextEncoder().encode(password + salt);
        const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const newHashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

        if (newHashHex === originalHash) {
          return new Response(JSON.stringify({ status: "ok", message: "Вход выполнен" }), { headers: corsHeaders });
        } else {
          return new Response(JSON.stringify({ error: "Неверный пароль" }), { status: 401, headers: corsHeaders });
        }
      } catch (e) {
        return new Response(JSON.stringify({ error: "Ошибка сервера: " + e.message }), { status: 500, headers: corsHeaders });
      }
    }

    // --- СМЕНА ПАРОЛЯ ---
    if (request.method === "POST" && url.pathname === "/change-password") {
      try {
        const body = await request.json();
        const { username, old_password, new_password } = body;

        if (!username || !old_password || !new_password) {
          return new Response(JSON.stringify({ error: "Заполни все поля" }), { status: 400, headers: corsHeaders });
        }

        const key = `user_${username}`;
        const storedValue = await env.VAGENT_USERS.get(key);

        if (!storedValue) {
          return new Response(JSON.stringify({ error: "Пользователь не найден" }), { status: 404, headers: corsHeaders });
        }

        // Проверяем старый пароль
        const [salt, originalHash] = storedValue.split('$');
        const msgUint8 = new TextEncoder().encode(old_password + salt);
        const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const newHashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

        if (newHashHex !== originalHash) {
          return new Response(JSON.stringify({ error: "Старый пароль неверный" }), { status: 401, headers: corsHeaders });
        }

        // Создаем новую соль и хеш для нового пароля
        const newSalt = crypto.getRandomValues(new Uint8Array(16)).join('');
        const newMsgUint8 = new TextEncoder().encode(new_password + newSalt);
        const newHashBuffer = await crypto.subtle.digest('SHA-256', newMsgUint8);
        const newHashArray = Array.from(new Uint8Array(newHashBuffer));
        const newStoredHash = newHashArray.map(b => b.toString(16).padStart(2, '0')).join('');

        await env.VAGENT_USERS.put(key, `${newSalt}$${newStoredHash}`);

        return new Response(JSON.stringify({ status: "ok", message: "Пароль изменен" }), { headers: corsHeaders });
      } catch (e) {
        return new Response(JSON.stringify({ error: "Ошибка сервера: " + e.message }), { status: 500, headers: corsHeaders });
      }
    }

    // --- ИИ (прокси к Cloudflare Workers AI; ключ пользователя приходит в теле запроса) ---
    if (request.method === "POST" && (url.pathname === "/ai/text" || url.pathname === "/ai/image")) {
      const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      try {
        const b = await request.json();
        const account = String(b.account_id || "");
        const token = String(b.token || "");
        if (!/^[a-f0-9]{32}$/i.test(account) || token.length < 20) return json({ error: "Проверь ключ Cloudflare в профиле" }, 400);
        const isImg = url.pathname === "/ai/image";
        const model = isImg ? "@cf/black-forest-labs/flux-1-schnell" : "@cf/meta/llama-3.1-8b-instruct";
        let payload;
        if (isImg) {
          const prompt = String(b.prompt || "").slice(0, 2000);
          if (!prompt) return json({ error: "Пустой запрос" }, 400);
          payload = { prompt, steps: 4 };
        } else {
          const messages = Array.isArray(b.messages) ? b.messages.slice(-12).map(m => ({ role: m.role === "assistant" ? "assistant" : m.role === "system" ? "system" : "user", content: String(m.content || "").slice(0, 6000) })) : [];
          if (!messages.length) return json({ error: "Пустой запрос" }, 400);
          payload = { messages, max_tokens: Math.min(Number(b.max_tokens) || 800, 1800), temperature: 0.9 };
        }
        const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${model}`, {
          method: "POST",
          headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok || d.success === false) return json({ error: (d.errors && d.errors[0] && d.errors[0].message) || "Cloudflare отклонил запрос" }, r.status || 502);
        return json(isImg ? { image: d.result.image } : { text: d.result.response });
      } catch (e) {
        return json({ error: "Ошибка сервера: " + e.message }, 500);
      }
    }

    // Если ничего не совпало
    return new Response("Not Found", { status: 404, headers: corsHeaders });
  }
};