export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // --- РЕГИСТРАЦИЯ ---
    if (request.method === "POST" && url.pathname === "/register") {
      try {
        const body = await request.json();
        const { username, password } = body;

        if (!username || !password) {
          return new Response(JSON.stringify({ error: "Нужны логин и пароль" }), { status: 400 });
        }

        const key = `user_${username}`;

        // Проверяем, есть ли уже такой пользователь
        const existing = await env.VAGENT_USERS.get(key);
        if (existing) {
          return new Response(JSON.stringify({ error: "Логин занят" }), { status: 409 });
        }

        // --- ХЕШИРОВАНИЕ (SHA-256 с солью) ---
        const salt = crypto.getRandomValues(new Uint8Array(16)).join('');
        const msgUint8 = new TextEncoder().encode(password + salt);
        const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

        const storedValue = `${salt}$${hashHex}`;

        // Сохраняем в KV
        await env.VAGENT_USERS.put(key, storedValue);

        return new Response(JSON.stringify({ status: "ok", message: "Аккаунт создан" }), {
          headers: { "Content-Type": "application/json" }
        });

      } catch (e) {
        return new Response(JSON.stringify({ error: "Ошибка сервера: " + e.message }), { status: 500 });
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
          return new Response(JSON.stringify({ error: "Пользователь не найден" }), { status: 404 });
        }

        const [salt, originalHash] = storedValue.split('$');

        const msgUint8 = new TextEncoder().encode(password + salt);
        const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        const newHashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

        if (newHashHex === originalHash) {
          return new Response(JSON.stringify({ status: "ok", message: "Вход выполнен" }), {
            headers: { "Content-Type": "application/json" }
          });
        } else {
          return new Response(JSON.stringify({ error: "Неверный пароль" }), { status: 401 });
        }

      } catch (e) {
        return new Response(JSON.stringify({ error: "Ошибка сервера: " + e.message }), { status: 500 });
      }
    }

    return new Response("Not Found", { status: 404 });
  }
};