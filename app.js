(() => {
  "use strict";

  const STORAGE_KEY = "flow-crm-state-v1";
  const UI_KEY = "flow-crm-ui-v1";

  const STATUS = {
    new: { label: "Новая", plural: "Новые", className: "status-new", color: "#6571d4" },
    contacted: { label: "Связались", plural: "Связались", className: "status-contacted", color: "#c38a39" },
    progress: { label: "В работе", plural: "В работе", className: "status-progress", color: "#438b99" },
    done: { label: "Выполнено", plural: "Выполнено", className: "status-done", color: "#3c8a67" },
  };

  const SOURCES = ["Instagram", "WhatsApp", "Telegram", "Сайт", "Звонок", "Рекомендация", "Другое"];

  const PAGE_META = {
    overview: ["Обзор", "Всё важное о вашем бизнесе"],
    leads: ["Заявки", "Управляйте продажами и статусами заказов"],
    clients: ["Клиенты", "Вся клиентская база в одном месте"],
    tasks: ["Задачи", "Планы и напоминания вашей команды"],
    analytics: ["Аналитика", "Показатели, которые помогают расти"],
    integrations: ["Интеграции", "Подключите привычные каналы к FLOW"],
    settings: ["Настройки", "Управление компанией и рабочим пространством"],
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  const dom = {
    shell: $("#app-shell"),
    main: $("#main-content"),
    modalOverlay: $("#modal-overlay"),
    modal: $("#modal"),
    drawerOverlay: $("#drawer-overlay"),
    drawer: $("#drawer"),
    toastRegion: $("#toast-region"),
    searchPopover: $("#search-popover"),
    searchInput: $("#global-search-input"),
    searchResults: $("#global-search-results"),
    notificationsPopover: $("#notifications-popover"),
  };

  const ui = {
    page: getRoute(),
    dashboardPeriod: "month",
    dashboardChart: "revenue",
    leadsView: "kanban",
    leadSearch: "",
    leadStatus: "all",
    leadSource: "all",
    leadSort: "createdAt",
    leadSortDirection: "desc",
    leadPage: 1,
    clientSearch: "",
    clientPage: 1,
    analyticsPeriod: "30",
    settingsTab: "company",
    draggingLeadId: null,
    selectedLeadIds: new Set(),
  };

  let state = loadState();
  let lastFocusedElement = null;
  let resizeTimer = null;

  function getRoute() {
    const route = window.location.hash.replace("#", "").split("?")[0];
    return PAGE_META[route] ? route : "overview";
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function initials(name) {
    return String(name || "?")
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() || "")
      .join("");
  }

  function isoAt(daysOffset = 0, hour = 10, minute = 0) {
    const date = new Date();
    date.setHours(hour, minute, 0, 0);
    date.setDate(date.getDate() + daysOffset);
    return date.toISOString();
  }

  function addMinutes(iso, minutes) {
    return new Date(new Date(iso).getTime() + minutes * 60000).toISOString();
  }

  function dayStart(date = new Date()) {
    const value = new Date(date);
    value.setHours(0, 0, 0, 0);
    return value;
  }

  function isToday(iso) {
    const date = new Date(iso);
    const today = new Date();
    return date.toDateString() === today.toDateString();
  }

  function formatCurrency(value, compact = false) {
    const amount = Number(value) || 0;
    const currency = state?.settings?.currency || "KGS";
    if (compact && Math.abs(amount) >= 1000000) {
      return `${(amount / 1000000).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} млн ${currency === "USD" ? "$" : "сом"}`;
    }
    const formatted = Math.round(amount).toLocaleString("ru-RU");
    return currency === "USD" ? `$${formatted}` : `${formatted} сом`;
  }

  function formatDate(iso, withTime = true) {
    if (!iso) return "—";
    const date = new Date(iso);
    const today = dayStart();
    const target = dayStart(date);
    const diff = Math.round((today - target) / 86400000);
    const time = date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
    if (diff === 0) return withTime ? `Сегодня, ${time}` : "Сегодня";
    if (diff === 1) return withTime ? `Вчера, ${time}` : "Вчера";
    if (diff === -1) return withTime ? `Завтра, ${time}` : "Завтра";
    return date.toLocaleDateString("ru-RU", { day: "numeric", month: "short", ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}) });
  }

  function formatLongDate(iso) {
    const date = new Date(iso);
    return date.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: date.getFullYear() !== new Date().getFullYear() ? "numeric" : undefined }) +
      `, ${date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}`;
  }

  function normalizePhone(phone) {
    return String(phone || "").replace(/\D/g, "");
  }

  function createHistory(status, createdAt) {
    const history = [{ at: createdAt, type: "created", text: "Заявка создана" }];
    if (status !== "new") {
      const steps = ["contacted", "progress", "done"];
      let previous = "new";
      for (const [index, step] of steps.entries()) {
        if (steps.indexOf(status) < index) break;
        history.push({
          at: addMinutes(createdAt, 21 + index * 36),
          type: "status",
          text: `Статус изменён: ${STATUS[previous].label} → ${STATUS[step].label}`,
        });
        previous = step;
        if (step === status) break;
      }
    } else {
      history.push({ at: addMinutes(createdAt, 6), type: "opened", text: "Менеджер открыл заявку" });
    }
    return history;
  }

  function makeLead(id, name, phone, service, amount, status, source, daysAgo, hour, minute, comment) {
    const createdAt = isoAt(-daysAgo, hour, minute);
    return {
      id,
      name,
      phone,
      service,
      amount,
      status,
      source,
      createdAt,
      comment,
      history: createHistory(status, createdAt),
    };
  }

  function createDemoData() {
    const leads = [
      makeLead(1042, "Алексей Иванов", "+996 555 123 456", "Полировка кузова", 12000, "new", "Instagram", 0, 10, 42, "Хочет убрать мелкие царапины на капоте. Позвонить после 12:00."),
      makeLead(1041, "Даниил Смирнов", "+996 700 321 111", "Химчистка салона", 7500, "progress", "WhatsApp", 0, 9, 18, "Автомобиль уже в боксе. Нужна готовность к 18:00."),
      makeLead(1040, "Мария Ким", "+996 555 222 333", "Керамическое покрытие", 18000, "contacted", "Instagram", 1, 15, 26, "Интересуется покрытием на 2 года."),
      makeLead(1039, "Тимур Садыков", "+996 707 456 908", "Полировка фар", 9500, "done", "Рекомендация", 2, 12, 10, "Клиент пришёл по рекомендации Аскара."),
      makeLead(1038, "Елена Петрова", "+996 772 345 876", "Защитная плёнка", 6500, "new", "Сайт", 2, 9, 45, "Нужен расчёт для передней части автомобиля."),
      makeLead(1037, "Арсен Токтогулов", "+996 500 456 789", "Комплексный детейлинг", 15000, "done", "Звонок", 3, 16, 5, "Повторный клиент, скидка 5%."),
      makeLead(1036, "Айжан Мамбетова", "+996 555 870 221", "Химчистка салона", 4500, "contacted", "Telegram", 4, 11, 38, "Есть детское кресло, нужна деликатная чистка."),
      makeLead(1035, "Никита Волков", "+996 700 667 811", "Полировка кузова", 11000, "done", "Instagram", 5, 14, 12, "Чёрный седан, есть голограммы после мойки."),
      makeLead(1034, "Алия Исакова", "+996 777 110 456", "Керамическое покрытие", 8000, "progress", "WhatsApp", 5, 10, 8, "Подготовка кузова завершена."),
      makeLead(1033, "Бекжан Асанов", "+996 555 908 765", "Антидождь", 10500, "done", "Сайт", 6, 17, 20, "Обработка всех стёкол."),
      makeLead(1032, "София Орлова", "+996 701 442 390", "Химчистка багажника", 4000, "new", "Telegram", 7, 13, 40, "После перевозки животных."),
      makeLead(1031, "Руслан Абдраев", "+996 555 443 122", "Полировка фар", 3500, "done", "Звонок", 8, 9, 30, "Стандартный комплекс."),
      makeLead(1030, "Каныкей Жумабекова", "+996 770 210 144", "Защитная плёнка", 7000, "contacted", "Instagram", 9, 15, 10, "Ожидает варианты плёнки."),
      makeLead(1029, "Антон Кравцов", "+996 555 332 919", "Мойка двигателя", 6000, "done", "Рекомендация", 10, 12, 25, "Без снятия защиты."),
      makeLead(1028, "Медина Шаршенова", "+996 500 102 345", "Озонация салона", 4000, "new", "WhatsApp", 11, 10, 50, "После покупки автомобиля."),
      makeLead(1027, "Максим Белов", "+996 702 888 404", "Комплексный детейлинг", 8000, "done", "Сайт", 11, 9, 12, "Подготовка автомобиля к продаже."),
      makeLead(1026, "Нурбек Алиев", "+996 555 674 230", "Керамическое покрытие", 4500, "contacted", "Instagram", 12, 14, 42, "Просит сравнить два пакета."),
      makeLead(1025, "Дарья Соколова", "+996 700 133 550", "Химчистка салона", 5500, "done", "Telegram", 13, 11, 5, "Светлый салон."),
      makeLead(1024, "Эльдар Мусаев", "+996 777 455 020", "Полировка кузова", 3000, "new", "Звонок", 14, 16, 30, "Нужна оценка после осмотра."),
      makeLead(1023, "Ирина Ли", "+996 555 221 009", "Антидождь", 6500, "done", "Instagram", 14, 10, 22, "Передние и боковые стёкла."),
      makeLead(1022, "Аскар Омуров", "+996 700 999 221", "Полировка фар", 5000, "done", "Рекомендация", 15, 13, 16, "Повторная обработка."),
      makeLead(1021, "Виктория Цой", "+996 555 376 145", "Защитная плёнка", 4500, "done", "WhatsApp", 15, 9, 55, "Плёнка на пороги и зоны ручек."),
      makeLead(1020, "Самат Кожоев", "+996 777 343 890", "Мойка двигателя", 7500, "contacted", "Сайт", 16, 17, 2, "Запросил свободные окна на выходные."),
      makeLead(1019, "Ольга Романова", "+996 500 811 256", "Озонация салона", 3500, "done", "Instagram", 17, 12, 12, "Устранение запаха табака."),
      makeLead(1018, "Азамат Эсенов", "+996 555 432 809", "Химчистка салона", 6000, "new", "Telegram", 17, 10, 15, "Кроссовер, тканевый салон."),
      makeLead(1017, "Полина Громова", "+996 701 840 665", "Полировка кузова", 2000, "done", "Рекомендация", 18, 14, 38, "Локальная полировка двери."),
      makeLead(1016, "Илья Миронов", "+996 555 091 733", "Антидождь", 1500, "done", "Звонок", 18, 9, 28, "Только лобовое стекло."),
    ];

    const coreClients = [
      { id: 1, name: "Алексей Иванов", phone: "+996 555 123 456", lastOrder: "Полировка", orders: 4, spent: 43500, lastContact: isoAt(0, 10, 42), createdAt: isoAt(-4, 12, 0), notes: "Предпочитает общение в WhatsApp. Чёрный Lexus RX.", ordersHistory: [{ service: "Полировка", amount: 12000, at: isoAt(0, 10, 42) }, { service: "Химчистка", amount: 8500, at: isoAt(-50, 12, 0) }, { service: "Керамика", amount: 18000, at: isoAt(-99, 11, 0) }, { service: "Антидождь", amount: 5000, at: isoAt(-160, 14, 0) }] },
      { id: 2, name: "Мария Ким", phone: "+996 555 222 333", lastOrder: "Керамика", orders: 7, spent: 96000, lastContact: isoAt(-3, 15, 26), createdAt: isoAt(-8, 11, 0), notes: "Постоянный клиент. Напомнить о повторном покрытии через 12 месяцев.", ordersHistory: [{ service: "Керамика", amount: 18000, at: isoAt(-1, 15, 26) }, { service: "Полировка", amount: 14000, at: isoAt(-80, 12, 0) }, { service: "Химчистка", amount: 9000, at: isoAt(-145, 10, 0) }] },
      { id: 3, name: "Даниил Смирнов", phone: "+996 700 321 111", lastOrder: "Химчистка", orders: 2, spent: 15500, lastContact: isoAt(0, 9, 18), createdAt: isoAt(-10, 9, 0), notes: "", ordersHistory: [] },
      { id: 4, name: "Тимур Садыков", phone: "+996 707 456 908", lastOrder: "Полировка фар", orders: 3, spent: 27000, lastContact: isoAt(-2, 12, 10), createdAt: isoAt(-12, 10, 0), notes: "Пришёл по рекомендации.", ordersHistory: [] },
      { id: 5, name: "Елена Петрова", phone: "+996 772 345 876", lastOrder: "Защитная плёнка", orders: 2, spent: 13000, lastContact: isoAt(-2, 9, 45), createdAt: isoAt(-14, 15, 0), notes: "", ordersHistory: [] },
      { id: 6, name: "Арсен Токтогулов", phone: "+996 500 456 789", lastOrder: "Детейлинг", orders: 8, spent: 121000, lastContact: isoAt(-3, 16, 5), createdAt: isoAt(-16, 12, 0), notes: "Скидка постоянного клиента 5%.", ordersHistory: [] },
      { id: 7, name: "Айжан Мамбетова", phone: "+996 555 870 221", lastOrder: "Химчистка", orders: 2, spent: 13000, lastContact: isoAt(-4, 11, 38), createdAt: isoAt(-18, 10, 0), notes: "", ordersHistory: [] },
      { id: 8, name: "Никита Волков", phone: "+996 700 667 811", lastOrder: "Полировка", orders: 5, spent: 58500, lastContact: isoAt(-5, 14, 12), createdAt: isoAt(-20, 14, 0), notes: "Чёрный седан.", ordersHistory: [] },
      { id: 9, name: "Алия Исакова", phone: "+996 777 110 456", lastOrder: "Керамика", orders: 3, spent: 34000, lastContact: isoAt(-5, 10, 8), createdAt: isoAt(-22, 9, 0), notes: "", ordersHistory: [] },
      { id: 10, name: "Бекжан Асанов", phone: "+996 555 908 765", lastOrder: "Антидождь", orders: 2, spent: 19000, lastContact: isoAt(-6, 17, 20), createdAt: isoAt(-24, 13, 0), notes: "", ordersHistory: [] },
      { id: 11, name: "София Орлова", phone: "+996 701 442 390", lastOrder: "Химчистка", orders: 4, spent: 29500, lastContact: isoAt(-7, 13, 40), createdAt: isoAt(-26, 10, 0), notes: "Есть собака.", ordersHistory: [] },
      { id: 12, name: "Руслан Абдраев", phone: "+996 555 443 122", lastOrder: "Полировка фар", orders: 6, spent: 48000, lastContact: isoAt(-8, 9, 30), createdAt: isoAt(-28, 12, 0), notes: "", ordersHistory: [] },
    ];

    const firstNames = ["Алина", "Мурат", "Ксения", "Адилет", "Диана", "Роман", "Жанара", "Денис", "Элина", "Мирлан", "Анастасия", "Кубаныч"];
    const lastNames = ["Осмонова", "Жапаров", "Николаева", "Касымов", "Сеитова", "Фёдоров", "Байзакова", "Попов", "Абдыева", "Ниязов", "Власова", "Турсунов"];
    const services = ["Полировка", "Химчистка", "Керамика", "Детейлинг", "Антидождь", "Защитная плёнка"];
    const generatedClients = Array.from({ length: 236 }, (_, index) => {
      const number = index + 13;
      const returning = index < 75;
      const recent = index < 22;
      const orders = returning ? 2 + (index % 6) : 1;
      return {
        id: number,
        name: `${firstNames[index % firstNames.length]} ${lastNames[(index * 5) % lastNames.length]}`,
        phone: `+996 ${500 + (index % 278)} ${String(100 + (index * 37) % 900)} ${String(100 + (index * 71) % 900)}`,
        lastOrder: services[index % services.length],
        orders,
        spent: orders * (4500 + (index % 9) * 950),
        lastContact: isoAt(-(2 + (index % 180)), 9 + (index % 8), (index * 7) % 60),
        createdAt: isoAt(-(recent ? index + 1 : 45 + index), 11, 0),
        notes: "",
        ordersHistory: [],
      };
    });

    return {
      version: 1,
      leads,
      clients: [...coreClients, ...generatedClients],
      tasks: [
        { id: 1, title: "Позвонить Алексею", dueAt: isoAt(0, 13, 0), completed: false, createdAt: isoAt(-1, 17, 0) },
        { id: 2, title: "Отправить расчёт Марии", dueAt: isoAt(0, 15, 30), completed: false, createdAt: isoAt(-1, 17, 15) },
        { id: 3, title: "Уточнить запись Дмитрия", dueAt: isoAt(1, 10, 0), completed: false, createdAt: isoAt(0, 9, 0) },
        { id: 4, title: "Заказать состав для керамики", dueAt: isoAt(3, 12, 0), completed: false, createdAt: isoAt(-2, 16, 0) },
        { id: 5, title: "Обновить прайс на услуги", dueAt: isoAt(-1, 18, 0), completed: true, createdAt: isoAt(-4, 12, 0), completedAt: isoAt(-1, 17, 20) },
      ],
      settings: {
        company: "Blackline Detailing",
        phone: "+996 555 404 404",
        email: "hello@blackline.kg",
        city: "Бишкек",
        currency: "KGS",
        userName: "Александр",
        userEmail: "alex@blackline.kg",
        notifications: { leads: true, tasks: true, digest: false },
      },
      notifications: [
        { id: 1, text: "Новая заявка от Алексея", time: "5 минут назад", read: false },
        { id: 2, text: "Мария перешла в статус «Выполнено»", time: "1 час назад", read: false },
        { id: 3, text: "Новая заявка из Instagram", time: "2 часа назад", read: false },
      ],
    };
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        const demo = createDemoData();
        localStorage.setItem(STORAGE_KEY, JSON.stringify(demo));
        return demo;
      }
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed.leads) || !Array.isArray(parsed.clients) || !Array.isArray(parsed.tasks) || !parsed.settings) {
        throw new Error("Некорректные данные");
      }
      return parsed;
    } catch (error) {
      console.warn("FLOW CRM: демо-данные восстановлены", error);
      const demo = createDemoData();
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(demo)); } catch (_) { /* localStorage может быть недоступен */ }
      return demo;
    }
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      updateShell();
      return true;
    } catch (error) {
      console.error("FLOW CRM: не удалось сохранить данные", error);
      toast("Не удалось сохранить", "Проверьте доступность хранилища браузера", "error");
      return false;
    }
  }

  function getMetrics(leads = state.leads) {
    const count = leads.length;
    const revenue = leads.reduce((sum, lead) => sum + (Number(lead.amount) || 0), 0);
    const average = count ? Math.round((revenue / count) / 10) * 10 : 0;
    const contacted = leads.filter((lead) => lead.status !== "new").length;
    const working = leads.filter((lead) => lead.status === "progress" || lead.status === "done").length;
    const completed = leads.filter((lead) => lead.status === "done").length;
    const conversion = contacted ? Math.min(100, Math.round((completed / contacted) * 100) + 1) : 0;
    return { count, revenue, average, contacted, working, completed, conversion };
  }

  function leadsForPeriod(period) {
    const limit = period === "today" ? 1 : period === "week" ? 7 : period === "month" ? 31 : Number(period) || 30;
    const since = new Date();
    since.setHours(0, 0, 0, 0);
    since.setDate(since.getDate() - (limit - 1));
    return state.leads.filter((lead) => new Date(lead.createdAt) >= since);
  }

  function updateShell() {
    const newLeads = state.leads.filter((lead) => lead.status === "new").length;
    const activeTasks = state.tasks.filter((task) => !task.completed).length;
    $("#leads-nav-count").textContent = newLeads;
    $("#tasks-nav-count").textContent = activeTasks;
    $$(".workspace-company").forEach((element) => { element.textContent = state.settings.company; });
    const unread = state.notifications.some((notification) => !notification.read);
    $(".unread-dot").style.display = unread ? "block" : "none";
    renderNotifications();
  }

  function statusBadge(status) {
    const meta = STATUS[status] || STATUS.new;
    return `<span class="status-badge ${meta.className}">${meta.label}</span>`;
  }

  function sourceBadge(source) {
    return `<span class="source-badge">${escapeHtml(source)}</span>`;
  }

  function clientAvatar(name, index = 0) {
    const palette = [
      ["#5360bd", "#eef0ff"], ["#377c6a", "#e8f5ef"], ["#9a6b31", "#fff4dd"],
      ["#7a59a8", "#f1edfb"], ["#397f8c", "#eaf7f8"], ["#a45353", "#fff0f0"],
    ][index % 6];
    return `<span class="client-avatar" style="--avatar-color:${palette[0]};--avatar-bg:${palette[1]}">${escapeHtml(initials(name))}</span>`;
  }

  function pageHeader(title, subtitle, actions = "") {
    return `<header class="page-header">
      <div class="page-heading"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(subtitle)}</p></div>
      ${actions ? `<div class="page-actions">${actions}</div>` : ""}
    </header>`;
  }

  function emptyState(title, text, action = "", compact = false) {
    return `<div class="empty-state${compact ? " compact" : ""}"><div><span class="empty-state-icon" aria-hidden="true">◇</span><h3>${escapeHtml(title)}</h3><p>${escapeHtml(text)}</p>${action}</div></div>`;
  }

  function renderPage() {
    ui.page = getRoute();
    $$(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.page === ui.page));
    closeMobileMenu();
    closePopovers();
    closeDrawer(false);

    switch (ui.page) {
      case "leads": renderLeads(); break;
      case "clients": renderClients(); break;
      case "tasks": renderTasks(); break;
      case "analytics": renderAnalytics(); break;
      case "integrations": renderIntegrations(); break;
      case "settings": renderSettings(); break;
      default: renderOverview();
    }
    dom.main.classList.remove("page-enter");
    void dom.main.offsetWidth;
    dom.main.classList.add("page-enter");
    dom.main.focus({ preventScroll: true });
  }

  function renderOverview() {
    const periodLeads = leadsForPeriod(ui.dashboardPeriod);
    const metrics = getMetrics(periodLeads);
    const recent = [...state.leads].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 10);

    const periodSwitch = `<div class="segmented" aria-label="Период обзора">
      ${[["today", "Сегодня"], ["week", "Неделя"], ["month", "Месяц"]].map(([value, label]) =>
        `<button type="button" data-action="dashboard-period" data-period="${value}" class="${ui.dashboardPeriod === value ? "active" : ""}">${label}</button>`
      ).join("")}
    </div>`;

    const kpis = [
      { label: "Выручка", value: formatCurrency(metrics.revenue), trend: "+12.4%", icon: "↗", color: "#5865d8", glow: "#eef0ff" },
      { label: "Новые заявки", value: metrics.count.toLocaleString("ru-RU"), trend: "+8.2%", icon: "+", color: "#397f8c", glow: "#eaf7f8" },
      { label: "Средний чек", value: formatCurrency(metrics.average), trend: "+5.1%", icon: "≋", color: "#9a6b31", glow: "#fff4dd" },
      { label: "Конверсия", value: `${metrics.conversion}%`, trend: "+3.4%", icon: "%", color: "#377c6a", glow: "#e8f5ef" },
    ];

    dom.main.innerHTML = `
      ${pageHeader(`Доброе утро, ${state.settings.userName} 👋`, "Вот что происходит с вашим бизнесом сегодня.", `${periodSwitch}<button class="primary-btn" type="button" data-action="new-lead"><span>＋</span> Новая заявка</button>`)}
      <section class="kpi-grid" aria-label="Ключевые показатели">
        ${kpis.map((kpi) => `<article class="card kpi-card" style="--kpi-color:${kpi.color};--kpi-glow:${kpi.glow}">
          <div class="kpi-top"><span class="kpi-label">${kpi.label}</span><span class="kpi-icon">${kpi.icon}</span></div>
          <div class="kpi-bottom"><strong class="kpi-value">${kpi.value}</strong><span class="trend"><span>↗</span>${kpi.trend}</span></div>
        </article>`).join("")}
      </section>
      <section class="overview-grid">
        <article class="card chart-card">
          <div class="card-header">
            <div class="card-header-text"><h2>${ui.dashboardChart === "revenue" ? "Выручка" : "Заявки"}</h2><p>Динамика за последние 7 дней</p></div>
            <div class="segmented" aria-label="Данные графика">
              <button type="button" data-action="dashboard-chart" data-chart="revenue" class="${ui.dashboardChart === "revenue" ? "active" : ""}">Выручка</button>
              <button type="button" data-action="dashboard-chart" data-chart="leads" class="${ui.dashboardChart === "leads" ? "active" : ""}">Заявки</button>
            </div>
          </div>
          <div class="chart-wrap"><canvas id="overview-chart" role="img" aria-label="График ${ui.dashboardChart === "revenue" ? "выручки" : "заявок"} за неделю"></canvas></div>
        </article>
        <article class="card funnel-card">
          <div class="card-header"><div class="card-header-text"><h2>Воронка продаж</h2><p>Переход между этапами</p></div><span class="trend">+6.8%</span></div>
          <div class="funnel-list">
            ${funnelRow("Новые", metrics.count, 100, "#6571d4")}
            ${funnelRow("Связались", metrics.contacted, metrics.count ? metrics.contacted / metrics.count * 100 : 0, "#c38a39")}
            ${funnelRow("В работе", metrics.working, metrics.count ? metrics.working / metrics.count * 100 : 0, "#438b99")}
            ${funnelRow("Выполнено", metrics.completed, metrics.count ? metrics.completed / metrics.count * 100 : 0, "#3c8a67")}
          </div>
        </article>
      </section>
      <section class="card data-card">
        <div class="card-header"><div class="card-header-text"><h2>Последние заявки</h2><p>Самые свежие обращения клиентов</p></div><button class="link-btn" type="button" data-action="go-leads">Все заявки →</button></div>
        <div class="table-wrap">
          <table class="data-table">
            <thead><tr><th>ID</th><th>Клиент</th><th>Телефон</th><th>Услуга</th><th>Сумма</th><th>Статус</th><th>Дата</th></tr></thead>
            <tbody>${recent.map((lead, index) => leadRow(lead, index, false)).join("")}</tbody>
          </table>
        </div>
      </section>`;

    requestAnimationFrame(drawOverviewChart);
  }

  function funnelRow(label, count, rate, color) {
    const width = Math.max(0, Math.min(100, rate));
    return `<div class="funnel-row" style="--step-color:${color};--bar-width:${width}%">
      <div class="funnel-meta"><span class="funnel-label"><i></i>${label}</span><strong class="funnel-count">${count}</strong></div>
      <div class="funnel-bar"><span></span></div><span class="funnel-rate">${Math.round(width)}% от входящего потока</span>
    </div>`;
  }

  function leadRow(lead, index, full = true) {
    return `<tr data-action="open-lead" data-lead-id="${lead.id}" tabindex="0">
      ${full ? `<td><input type="checkbox" data-action="select-lead" data-lead-id="${lead.id}" aria-label="Выбрать заявку #${lead.id}" ${ui.selectedLeadIds.has(lead.id) ? "checked" : ""}></td>` : ""}
      <td class="primary-cell">#${lead.id}</td>
      <td><div class="client-cell">${clientAvatar(lead.name, index)}<div class="client-name-stack"><strong>${escapeHtml(lead.name)}</strong><small>${escapeHtml(lead.source)}</small></div></div></td>
      <td>${escapeHtml(lead.phone)}</td>
      <td>${escapeHtml(lead.service)}</td>
      <td class="money-cell">${formatCurrency(lead.amount)}</td>
      <td>${statusBadge(lead.status)}</td>
      ${full ? `<td>${sourceBadge(lead.source)}</td>` : ""}
      <td class="muted-cell">${formatDate(lead.createdAt)}</td>
      ${full ? `<td><button class="task-action" type="button" data-action="open-lead" data-lead-id="${lead.id}" aria-label="Открыть заявку">•••</button></td>` : ""}
    </tr>`;
  }

  function drawOverviewChart() {
    const canvas = $("#overview-chart");
    if (!canvas) return;
    const total = getMetrics(leadsForPeriod(ui.dashboardPeriod));
    const baseRevenue = [18000, 27000, 22000, 34000, 29000, 31000, 23500];
    const baseLeads = [3, 5, 4, 6, 3, 4, 2];
    const baseTotal = baseRevenue.reduce((sum, value) => sum + value, 0);
    const values = ui.dashboardChart === "revenue"
      ? baseRevenue.map((value) => Math.round(value * (total.revenue / (baseTotal || 1))))
      : baseLeads.map((value) => Math.max(0, Math.round(value * (total.count / 27))));
    drawLineChart(canvas, values, ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"], {
      currency: ui.dashboardChart === "revenue",
      color: "#5865d8",
    });
  }

  function filterLeads() {
    const query = ui.leadSearch.trim().toLowerCase();
    const filtered = state.leads.filter((lead) => {
      const matchesQuery = !query || [lead.name, lead.phone, lead.service, String(lead.id)].some((value) => String(value).toLowerCase().includes(query));
      const matchesStatus = ui.leadStatus === "all" || lead.status === ui.leadStatus;
      const matchesSource = ui.leadSource === "all" || lead.source === ui.leadSource;
      return matchesQuery && matchesStatus && matchesSource;
    });
    return filtered.sort((a, b) => {
      let first = a[ui.leadSort];
      let second = b[ui.leadSort];
      if (ui.leadSort === "createdAt") { first = new Date(first).getTime(); second = new Date(second).getTime(); }
      if (typeof first === "string") { first = first.toLowerCase(); second = String(second).toLowerCase(); }
      const direction = ui.leadSortDirection === "asc" ? 1 : -1;
      return first > second ? direction : first < second ? -direction : 0;
    });
  }

  function renderLeads() {
    const filtered = filterLeads();
    const actions = `<div class="segmented view-switch" aria-label="Вид заявок">
      <button type="button" data-action="leads-view" data-view="kanban" class="${ui.leadsView === "kanban" ? "active" : ""}">Канбан</button>
      <button type="button" data-action="leads-view" data-view="table" class="${ui.leadsView === "table" ? "active" : ""}">Таблица</button>
    </div><button class="primary-btn" type="button" data-action="new-lead"><span>＋</span> Новая заявка</button>`;

    dom.main.innerHTML = `
      ${pageHeader("Заявки", `${state.leads.length} заявок во всех статусах`, actions)}
      <div class="table-toolbar">
        <label class="field-search"><span class="search-symbol" aria-hidden="true"></span><input id="lead-search" type="search" value="${escapeHtml(ui.leadSearch)}" placeholder="Поиск по клиенту, телефону или услуге" aria-label="Поиск заявок"></label>
        <select class="control" id="lead-status-filter" aria-label="Фильтр по статусу">
          <option value="all">Все статусы</option>${Object.entries(STATUS).map(([key, meta]) => `<option value="${key}" ${ui.leadStatus === key ? "selected" : ""}>${meta.label}</option>`).join("")}
        </select>
        <select class="control" id="lead-source-filter" aria-label="Фильтр по источнику">
          <option value="all">Все источники</option>${SOURCES.map((source) => `<option value="${source}" ${ui.leadSource === source ? "selected" : ""}>${source}</option>`).join("")}
        </select>
      </div>
      <div id="leads-surface">${ui.leadsView === "kanban" ? kanbanTemplate(filtered) : leadsTableTemplate(filtered)}</div>`;
  }

  function kanbanTemplate(leads) {
    return `<section class="kanban-board" aria-label="Канбан заявок">
      ${Object.entries(STATUS).map(([status, meta]) => {
        const items = leads.filter((lead) => lead.status === status);
        return `<section class="kanban-column" data-status="${status}" style="--column-color:${meta.color}">
          <header class="kanban-column-head"><span class="column-title"><i></i>${meta.plural}</span><span class="column-count">${items.length}</span></header>
          <div class="kanban-stack" data-drop-status="${status}">
            ${items.length ? items.map((lead) => kanbanCard(lead)).join("") : emptyState("Здесь пока пусто", "Перетащите сюда заявку", "", true)}
          </div>
        </section>`;
      }).join("")}
    </section>`;
  }

  function kanbanCard(lead) {
    return `<article class="lead-card" draggable="true" tabindex="0" data-action="open-lead" data-lead-id="${lead.id}" style="--card-color:${STATUS[lead.status].color}" aria-label="Заявка #${lead.id}, ${escapeHtml(lead.name)}">
      <div class="lead-card-top"><strong class="lead-card-name">${escapeHtml(lead.name)}</strong><span class="lead-card-id">#${lead.id}</span></div>
      <div class="lead-card-service">${escapeHtml(lead.service)}</div>
      <div class="lead-card-amount">${formatCurrency(lead.amount)}</div>
      <div class="lead-card-meta"><span>${formatDate(lead.createdAt)}</span>${sourceBadge(lead.source)}</div>
      <div class="lead-card-footer"><span class="lead-phone">${escapeHtml(lead.phone)}</span><span class="drag-hint" aria-hidden="true">⠿</span></div>
    </article>`;
  }

  function leadsTableTemplate(leads) {
    const perPage = 8;
    const pages = Math.max(1, Math.ceil(leads.length / perPage));
    ui.leadPage = Math.min(ui.leadPage, pages);
    const start = (ui.leadPage - 1) * perPage;
    const pageItems = leads.slice(start, start + perPage);
    const sortArrow = (key) => ui.leadSort === key ? (ui.leadSortDirection === "asc" ? " ↑" : " ↓") : "";
    if (!leads.length) return `<section class="card data-card">${emptyState("Заявки не найдены", "Измените поиск или фильтры", `<button class="secondary-btn" type="button" data-action="clear-lead-filters">Сбросить фильтры</button>`)}</section>`;
    return `<section class="card data-card">
      <div class="table-wrap"><table class="data-table"><thead><tr>
        <th><input type="checkbox" aria-label="Выбрать все заявки на странице" data-action="select-page-leads"></th>
        <th data-action="sort-leads" data-sort="id" role="button" tabindex="0">ID${sortArrow("id")}</th>
        <th data-action="sort-leads" data-sort="name" role="button" tabindex="0">Клиент${sortArrow("name")}</th>
        <th>Телефон</th><th data-action="sort-leads" data-sort="service" role="button" tabindex="0">Услуга${sortArrow("service")}</th>
        <th data-action="sort-leads" data-sort="amount" role="button" tabindex="0">Сумма${sortArrow("amount")}</th>
        <th>Статус</th><th>Источник</th>
        <th data-action="sort-leads" data-sort="createdAt" role="button" tabindex="0">Дата${sortArrow("createdAt")}</th><th></th>
      </tr></thead><tbody>${pageItems.map((lead, index) => leadRow(lead, index, true)).join("")}</tbody></table></div>
      ${paginationTemplate(ui.leadPage, pages, leads.length, start, pageItems.length, "lead-page")}
    </section>`;
  }

  function paginationTemplate(current, pages, total, start, visible, action) {
    const buttons = [];
    for (let page = 1; page <= pages; page += 1) {
      if (pages > 7 && page > 2 && page < pages - 1 && Math.abs(page - current) > 1) {
        if (buttons.at(-1) !== "ellipsis") buttons.push("ellipsis");
      } else buttons.push(page);
    }
    return `<div class="pagination"><span class="pagination-info">Показано ${total ? start + 1 : 0}–${start + visible} из ${total}</span>
      <div class="pagination-buttons"><button class="page-btn" type="button" data-action="${action}" data-page="${current - 1}" ${current === 1 ? "disabled" : ""} aria-label="Предыдущая страница">‹</button>
      ${buttons.map((page) => page === "ellipsis" ? `<span class="page-btn">…</span>` : `<button class="page-btn ${page === current ? "active" : ""}" type="button" data-action="${action}" data-page="${page}">${page}</button>`).join("")}
      <button class="page-btn" type="button" data-action="${action}" data-page="${current + 1}" ${current === pages ? "disabled" : ""} aria-label="Следующая страница">›</button></div></div>`;
  }

  function filteredClients() {
    const query = ui.clientSearch.trim().toLowerCase();
    return state.clients.filter((client) => !query || [client.name, client.phone, client.lastOrder].some((value) => String(value).toLowerCase().includes(query)));
  }

  function renderClients() {
    const clients = filteredClients();
    const recentCount = state.clients.filter((client) => (Date.now() - new Date(client.createdAt).getTime()) <= 30 * 86400000).length;
    const returningCount = state.clients.filter((client) => client.orders > 1).length;
    const perPage = 10;
    const pages = Math.max(1, Math.ceil(clients.length / perPage));
    ui.clientPage = Math.min(ui.clientPage, pages);
    const start = (ui.clientPage - 1) * perPage;
    const pageItems = clients.slice(start, start + perPage);

    dom.main.innerHTML = `
      ${pageHeader("Клиенты", "Вся клиентская база в одном месте", `<button class="primary-btn" type="button" data-action="new-client"><span>＋</span> Добавить клиента</button>`)}
      <section class="stat-strip">
        ${stripStat("◎", state.clients.length, "Всего клиентов")}
        ${stripStat("↗", recentCount, "Новых за месяц")}
        ${stripStat("♢", returningCount, "Постоянных")}
      </section>
      <div class="table-toolbar"><label class="field-search"><span class="search-symbol" aria-hidden="true"></span><input id="client-search" type="search" value="${escapeHtml(ui.clientSearch)}" placeholder="Найти клиента по имени или телефону" aria-label="Поиск клиентов"></label></div>
      <section class="card data-card">
        ${clients.length ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>Клиент</th><th>Телефон</th><th>Последний заказ</th><th>Заказов</th><th>Потрачено</th><th>Последний контакт</th><th></th></tr></thead>
          <tbody>${pageItems.map((client, index) => `<tr data-action="open-client" data-client-id="${client.id}" tabindex="0">
            <td><div class="client-cell">${clientAvatar(client.name, index)}<div class="client-name-stack"><strong>${escapeHtml(client.name)}</strong><small>Клиент #${client.id}</small></div></div></td>
            <td>${escapeHtml(client.phone)}</td><td>${escapeHtml(client.lastOrder || "—")}</td><td class="primary-cell">${client.orders}</td><td class="money-cell">${formatCurrency(client.spent)}</td><td class="muted-cell">${formatDate(client.lastContact, false)}</td>
            <td><button class="task-action" type="button" data-action="open-client" data-client-id="${client.id}" aria-label="Открыть клиента">•••</button></td></tr>`).join("")}</tbody></table></div>
          ${paginationTemplate(ui.clientPage, pages, clients.length, start, pageItems.length, "client-page")}` : emptyState("Клиенты не найдены", "Попробуйте изменить поисковый запрос", `<button class="secondary-btn" type="button" data-action="clear-client-search">Сбросить поиск</button>`)}
      </section>`;
  }

  function stripStat(icon, value, label) {
    return `<article class="strip-stat"><span class="strip-icon">${icon}</span><div class="strip-copy"><strong>${Number(value).toLocaleString("ru-RU")}</strong><span>${label}</span></div></article>`;
  }

  function renderTasks() {
    const now = new Date();
    const todayEnd = new Date(); todayEnd.setHours(23, 59, 59, 999);
    const active = state.tasks.filter((task) => !task.completed);
    const today = active.filter((task) => new Date(task.dueAt) <= todayEnd);
    const upcoming = active.filter((task) => new Date(task.dueAt) > todayEnd);
    const completed = state.tasks.filter((task) => task.completed).sort((a, b) => new Date(b.completedAt || b.dueAt) - new Date(a.completedAt || a.dueAt));

    dom.main.innerHTML = `
      ${pageHeader("Задачи", `${active.length} активных задач`, `<button class="primary-btn" type="button" data-action="new-task"><span>＋</span> Новая задача</button>`)}
      <section class="tasks-board">
        ${taskColumn("Сегодня", today, "#c38a39", now)}
        ${taskColumn("Предстоящие", upcoming, "#6571d4", now)}
        ${taskColumn("Выполненные", completed, "#3c8a67", now, true)}
      </section>`;
  }

  function taskColumn(title, tasks, color, now, completed = false) {
    return `<section class="task-column" style="--task-color:${color}"><header class="task-column-head"><strong><i></i>${title}</strong><span class="column-count">${tasks.length}</span></header>
      <div class="task-list">${tasks.length ? tasks.map((task) => taskCard(task, now)).join("") : emptyState(completed ? "Пока ничего" : "Задач нет", completed ? "Выполненные задачи появятся здесь" : "Добавьте новую задачу", "", true)}</div></section>`;
  }

  function taskCard(task, now) {
    const overdue = !task.completed && new Date(task.dueAt) < now;
    return `<article class="task-card ${task.completed ? "completed" : ""}">
      <div class="task-main"><button class="task-check" type="button" data-action="toggle-task" data-task-id="${task.id}" aria-label="${task.completed ? "Вернуть задачу" : "Отметить задачу выполненной"}">${task.completed ? "✓" : ""}</button>
      <div class="task-copy"><div class="task-title">${escapeHtml(task.title)}</div><div class="task-date ${overdue ? "overdue" : ""}">${overdue ? "Просрочено · " : ""}${formatDate(task.dueAt)}</div></div></div>
      <div class="task-actions"><button class="task-action" type="button" data-action="edit-task" data-task-id="${task.id}" aria-label="Редактировать задачу">✎</button><button class="task-action danger" type="button" data-action="delete-task" data-task-id="${task.id}" aria-label="Удалить задачу">×</button></div>
    </article>`;
  }

  function renderAnalytics() {
    const periodLeads = leadsForPeriod(ui.analyticsPeriod);
    const metrics = getMetrics(periodLeads);
    const actions = `<div class="segmented" aria-label="Период аналитики">${[["7", "7 дней"], ["30", "30 дней"], ["90", "90 дней"], ["365", "Год"]].map(([value, label]) => `<button type="button" data-action="analytics-period" data-period="${value}" class="${ui.analyticsPeriod === value ? "active" : ""}>${label}</button>`).join("")}</div>`;
    const kpis = [
      ["Выручка", formatCurrency(metrics.revenue), "+12.4%", "↗", "#5865d8", "#eef0ff"],
      ["Количество заказов", metrics.count, "+8.2%", "#", "#397f8c", "#eaf7f8"],
      ["Средний чек", formatCurrency(metrics.average), "+5.1%", "≋", "#9a6b31", "#fff4dd"],
      ["Конверсия", `${metrics.conversion}%`, "+3.4%", "%", "#377c6a", "#e8f5ef"],
    ];
    const sourceData = [
      ["Instagram", 38, "#5865d8"], ["WhatsApp", 24, "#77a4b3"], ["Telegram", 16, "#9b87cc"], ["Сайт", 12, "#c69b58"], ["Рекомендации", 10, "#78a482"],
    ];
    const services = [
      ["Полировка", 38, 456000, 100], ["Химчистка", 31, 232500, 82], ["Керамика", 19, 342000, 50], ["Детейлинг", 17, 102000, 45],
    ];

    dom.main.innerHTML = `
      ${pageHeader("Аналитика", "Показатели, которые помогают вашему бизнесу расти", actions)}
      <section class="kpi-grid">${kpis.map(([label, value, trend, icon, color, glow]) => `<article class="card kpi-card" style="--kpi-color:${color};--kpi-glow:${glow}"><div class="kpi-top"><span class="kpi-label">${label}</span><span class="kpi-icon">${icon}</span></div><div class="kpi-bottom"><strong class="kpi-value">${value}</strong><span class="trend">↗ ${trend}</span></div></article>`).join("")}</section>
      <section class="analytics-grid">
        <article class="card chart-card"><div class="card-header"><div class="card-header-text"><h2>Выручка</h2><p>Динамика за выбранный период</p></div><span class="chart-legend"><i class="legend-dot"></i>Выручка</span></div><div class="chart-wrap"><canvas id="analytics-chart" role="img" aria-label="График выручки"></canvas></div></article>
        <article class="card"><div class="card-header"><div class="card-header-text"><h2>Источники заявок</h2><p>Распределение обращений</p></div></div><div class="donut-layout"><div class="donut"><div class="donut-center"><strong>100%</strong><span>все заявки</span></div></div><div class="donut-legend">${sourceData.map(([name, percent, color]) => `<div class="donut-item" style="--legend-color:${color}"><i></i><span>${name}</span><strong>${percent}%</strong></div>`).join("")}</div></div></article>
      </section>
      <section class="card"><div class="card-header"><div class="card-header-text"><h2>Популярные услуги</h2><p>По количеству заказов и выручке</p></div></div><div class="services-list">${services.map(([name, orders, revenue, width]) => `<div class="service-row"><div class="service-title"><strong>${name}</strong><div class="service-track" style="--service-width:${width}%"><span></span></div></div><span class="service-orders">${orders} заказов</span><span class="service-revenue">${formatCurrency(revenue)}</span></div>`).join("")}</div></section>`;
    requestAnimationFrame(drawAnalyticsChart);
  }

  function drawAnalyticsChart() {
    const canvas = $("#analytics-chart");
    if (!canvas) return;
    const series = {
      "7": { labels: ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"], values: [18000, 27000, 22000, 34000, 29000, 31000, 23500] },
      "30": { labels: ["1 авг", "5 авг", "10 авг", "15 авг", "20 авг", "25 авг", "30 авг"], values: [126000, 152000, 139000, 188000, 173000, 215000, 236000] },
      "90": { labels: ["Июн", "Нед. 2", "Июл", "Нед. 2", "Авг", "Нед. 2", "Сейчас"], values: [390000, 425000, 468000, 443000, 517000, 548000, 612000] },
      "365": { labels: ["Сен", "Ноя", "Янв", "Мар", "Май", "Июл", "Авг"], values: [920000, 1050000, 980000, 1240000, 1390000, 1510000, 1680000] },
    }[ui.analyticsPeriod];
    drawLineChart(canvas, series.values, series.labels, { currency: true, color: "#5865d8" });
  }

  function drawLineChart(canvas, values, labels, options = {}) {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(rect.width * ratio);
    canvas.height = Math.floor(rect.height * ratio);
    const ctx = canvas.getContext("2d");
    ctx.scale(ratio, ratio);
    const width = rect.width;
    const height = rect.height;
    const padding = { top: 18, right: 16, bottom: 34, left: 52 };
    const chartWidth = width - padding.left - padding.right;
    const chartHeight = height - padding.top - padding.bottom;
    const max = Math.max(...values, 1);
    const roundedMax = max <= 10 ? Math.ceil(max / 2) * 2 : Math.ceil(max / Math.pow(10, Math.floor(Math.log10(max)) - 1)) * Math.pow(10, Math.floor(Math.log10(max)) - 1);
    const points = values.map((value, index) => ({
      x: padding.left + (chartWidth / Math.max(1, values.length - 1)) * index,
      y: padding.top + chartHeight - (value / roundedMax) * chartHeight,
    }));

    ctx.clearRect(0, 0, width, height);
    ctx.font = "10px Inter, sans-serif";
    ctx.textBaseline = "middle";
    for (let i = 0; i <= 4; i += 1) {
      const y = padding.top + (chartHeight / 4) * i;
      ctx.beginPath();
      ctx.strokeStyle = "#eceef2";
      ctx.lineWidth = 1;
      ctx.moveTo(padding.left, y);
      ctx.lineTo(width - padding.right, y);
      ctx.stroke();
      const value = roundedMax - (roundedMax / 4) * i;
      const label = options.currency ? (value >= 1000000 ? `${(value / 1000000).toFixed(1)}м` : `${Math.round(value / 1000)}к`) : Math.round(value).toString();
      ctx.fillStyle = "#9aa0ab";
      ctx.textAlign = "right";
      ctx.fillText(label, padding.left - 10, y);
    }

    labels.forEach((label, index) => {
      const x = padding.left + (chartWidth / Math.max(1, labels.length - 1)) * index;
      ctx.fillStyle = "#8f96a2";
      ctx.textAlign = index === 0 ? "left" : index === labels.length - 1 ? "right" : "center";
      ctx.fillText(label, x, height - 11);
    });

    const gradient = ctx.createLinearGradient(0, padding.top, 0, height - padding.bottom);
    gradient.addColorStop(0, "rgba(88, 101, 216, .18)");
    gradient.addColorStop(1, "rgba(88, 101, 216, 0)");
    ctx.beginPath();
    ctx.moveTo(points[0].x, height - padding.bottom);
    ctx.lineTo(points[0].x, points[0].y);
    drawSmoothPath(ctx, points);
    ctx.lineTo(points.at(-1).x, height - padding.bottom);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    drawSmoothPath(ctx, points);
    ctx.strokeStyle = options.color || "#5865d8";
    ctx.lineWidth = 2.2;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke();

    points.forEach((point) => {
      ctx.beginPath();
      ctx.arc(point.x, point.y, 3.1, 0, Math.PI * 2);
      ctx.fillStyle = "#fff";
      ctx.fill();
      ctx.strokeStyle = options.color || "#5865d8";
      ctx.lineWidth = 1.8;
      ctx.stroke();
    });
  }

  function drawSmoothPath(ctx, points) {
    for (let i = 1; i < points.length; i += 1) {
      const previous = points[i - 1];
      const current = points[i];
      const midpoint = (previous.x + current.x) / 2;
      ctx.bezierCurveTo(midpoint, previous.y, midpoint, current.y, current.x, current.y);
    }
  }

  function renderIntegrations() {
    const integrations = [
      ["Telegram", "Получайте уведомления о новых заявках", "Не подключено", "T", "#4a8fb5", "#eaf5fa", true],
      ["WhatsApp", "Общайтесь с клиентами прямо из CRM", "Не подключено", "W", "#3a9567", "#e8f5ef", true],
      ["Instagram", "Получайте заявки из Instagram", "Скоро", "I", "#9562a5", "#f4edf6", false],
      ["Google Calendar", "Синхронизируйте записи и задачи", "Не подключено", "G", "#5570bb", "#eef1fa", true],
    ];
    dom.main.innerHTML = `
      ${pageHeader("Интеграции", "Подключайте сервисы, которыми пользуется ваша команда")}
      <div class="integrations-grid">${integrations.map(([name, description, status, icon, color, bg, active]) => `<article class="card integration-card">
        <span class="integration-logo" style="--logo-color:${color};--logo-bg:${bg}">${icon}</span><div class="integration-copy"><h3>${name}</h3><p>${description}</p><span class="integration-status">${status}</span></div>
        <button class="${active ? "secondary-btn" : "ghost-btn"} integration-action" type="button" data-action="integration-demo" data-integration="${name}" ${active ? "" : "disabled"}>${active ? "Подключить" : "Скоро"}</button>
      </article>`).join("")}</div>
      <div class="card" style="margin-top:16px;padding:18px 20px;color:var(--ink-soft);font-size:10.5px"><strong style="color:var(--ink)">Демо-режим</strong><br>Подключение внешних сервисов потребует API и безопасной серверной авторизации. В MVP показан интерфейс будущих интеграций без имитации реального соединения.</div>`;
  }

  function renderSettings() {
    const tabs = [["company", "Компания"], ["user", "Пользователь"], ["notifications", "Уведомления"], ["pipeline", "Воронка"], ["currency", "Валюта"]];
    dom.main.innerHTML = `
      ${pageHeader("Настройки", "Управление компанией и рабочим пространством")}
      <div class="settings-layout"><nav class="card settings-nav" aria-label="Разделы настроек">${tabs.map(([key, label]) => `<button class="settings-tab ${ui.settingsTab === key ? "active" : ""}" type="button" data-action="settings-tab" data-tab="${key}">${label}</button>`).join("")}</nav>
      <section class="card settings-panel" id="settings-panel">${settingsPanelTemplate()}</section></div>`;
  }

  function settingsPanelTemplate() {
    if (ui.settingsTab === "user") {
      return `<div class="settings-panel-head"><h2>Пользователь</h2><p>Личные данные администратора пространства</p></div>
        <form id="user-form"><div class="settings-form"><div class="form-field"><label for="user-name">Имя</label><input id="user-name" name="userName" value="${escapeHtml(state.settings.userName)}" required></div><div class="form-field"><label for="user-email">Email</label><input id="user-email" name="userEmail" type="email" value="${escapeHtml(state.settings.userEmail)}" required></div></div><div class="settings-actions"><button class="primary-btn" type="submit">Сохранить изменения</button></div></form>`;
    }
    if (ui.settingsTab === "notifications") {
      const items = [["leads", "Новые заявки", "Уведомлять о новых обращениях"], ["tasks", "Задачи", "Напоминать о предстоящих задачах"], ["digest", "Еженедельный отчёт", "Краткая аналитика раз в неделю"]];
      return `<div class="settings-panel-head"><h2>Уведомления</h2><p>Выберите события, о которых хотите узнавать</p></div>${items.map(([key, title, text]) => `<div class="toggle-row"><div class="toggle-copy"><strong>${title}</strong><span>${text}</span></div><button class="toggle ${state.settings.notifications[key] ? "on" : ""}" type="button" role="switch" aria-checked="${state.settings.notifications[key]}" data-action="toggle-notification-setting" data-setting="${key}"></button></div>`).join("")}`;
    }
    if (ui.settingsTab === "pipeline") {
      return `<div class="settings-panel-head"><h2>Воронка</h2><p>Этапы движения заявки от обращения до оплаты</p></div><div class="pipeline-preview">${Object.entries(STATUS).map(([key, meta], index) => `<div class="pipeline-step" style="--step-color:${meta.color}"><i></i><span>${meta.label}</span><small>${index + 1} этап</small></div>`).join("")}</div><p style="max-width:560px;margin-top:15px;color:var(--ink-faint);font-size:10px">В MVP этапы зафиксированы, чтобы аналитика и Kanban оставались согласованными.</p>`;
    }
    if (ui.settingsTab === "currency") {
      return `<div class="settings-panel-head"><h2>Валюта</h2><p>Используется для сумм, отчётов и аналитики</p></div><form id="currency-form"><div class="settings-form"><div class="form-field"><label for="currency">Основная валюта</label><select id="currency" name="currency"><option value="KGS" ${state.settings.currency === "KGS" ? "selected" : ""}>KGS — сом</option><option value="USD" ${state.settings.currency === "USD" ? "selected" : ""}>USD — доллар</option></select><span class="field-hint">Пересчёт курсов в демо-версии не выполняется.</span></div></div><div class="settings-actions"><button class="primary-btn" type="submit">Сохранить валюту</button></div></form>`;
    }
    return `<div class="settings-panel-head"><h2>Компания</h2><p>Основные данные вашего бизнеса</p></div>
      <form id="company-form"><div class="settings-form"><div class="form-field span-2"><label for="company-name">Название компании</label><input id="company-name" name="company" value="${escapeHtml(state.settings.company)}" required></div><div class="form-field"><label for="company-phone">Телефон</label><input id="company-phone" name="phone" value="${escapeHtml(state.settings.phone)}"></div><div class="form-field"><label for="company-email">Email</label><input id="company-email" name="email" type="email" value="${escapeHtml(state.settings.email)}"></div><div class="form-field"><label for="company-city">Город</label><input id="company-city" name="city" value="${escapeHtml(state.settings.city)}"></div><div class="form-field"><label for="company-currency-preview">Валюта</label><input id="company-currency-preview" value="${state.settings.currency === "KGS" ? "KGS — сом" : "USD — доллар"}" disabled></div></div><div class="settings-actions"><button class="primary-btn" type="submit">Сохранить изменения</button></div></form>
      <div class="danger-zone"><h3>Сбросить демо-данные</h3><p>Все созданные заявки, клиенты, задачи и настройки будут заменены исходным набором.</p><button class="danger-btn" type="button" data-action="reset-demo">Сбросить демо-данные</button></div>`;
  }

  function renderNotifications() {
    const list = $("#notifications-list");
    if (!list || !state?.notifications) return;
    list.innerHTML = state.notifications.length
      ? state.notifications.slice(0, 8).map((notification) => `<div class="notification-item ${notification.read ? "read" : ""}"><span class="notification-marker"></span><div class="notification-copy"><strong>${escapeHtml(notification.text)}</strong><small>${escapeHtml(notification.time)}</small></div></div>`).join("")
      : emptyState("Уведомлений нет", "Здесь появятся важные события", "", true);
  }

  function notify(text) {
    const nextId = Math.max(0, ...state.notifications.map((item) => item.id)) + 1;
    state.notifications.unshift({ id: nextId, text, time: "Только что", read: false });
    state.notifications = state.notifications.slice(0, 20);
  }

  function toast(title, text = "Данные сохранены в FLOW CRM", type = "success") {
    const element = document.createElement("div");
    element.className = `toast ${type}`;
    element.innerHTML = `<span class="toast-icon">${type === "error" ? "!" : "✓"}</span><div class="toast-copy"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(text)}</span></div>`;
    dom.toastRegion.append(element);
    while (dom.toastRegion.children.length > 4) dom.toastRegion.firstElementChild.remove();
    window.setTimeout(() => {
      element.classList.add("out");
      window.setTimeout(() => element.remove(), 210);
    }, 3300);
  }

  function openModal(content, small = false) {
    lastFocusedElement = document.activeElement;
    dom.modal.className = `modal${small ? " small" : ""}`;
    dom.modal.innerHTML = content;
    dom.modalOverlay.classList.add("open");
    dom.modalOverlay.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
    requestAnimationFrame(() => {
      const focusTarget = $("input:not([type=hidden]), select, textarea, button", dom.modal);
      focusTarget?.focus();
    });
  }

  function closeModal(restoreFocus = true) {
    if (!dom.modalOverlay.classList.contains("open")) return;
    dom.modalOverlay.classList.remove("open");
    dom.modalOverlay.setAttribute("aria-hidden", "true");
    document.body.style.overflow = dom.drawerOverlay.classList.contains("open") ? "hidden" : "";
    window.setTimeout(() => { dom.modal.innerHTML = ""; }, 210);
    if (restoreFocus && lastFocusedElement instanceof HTMLElement) lastFocusedElement.focus({ preventScroll: true });
  }

  function openDrawer(content) {
    lastFocusedElement = document.activeElement;
    dom.drawer.innerHTML = content;
    dom.drawerOverlay.classList.add("open");
    dom.drawerOverlay.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
    requestAnimationFrame(() => $(".close-btn", dom.drawer)?.focus());
  }

  function closeDrawer(restoreFocus = true) {
    if (!dom.drawerOverlay.classList.contains("open")) return;
    dom.drawerOverlay.classList.remove("open");
    dom.drawerOverlay.setAttribute("aria-hidden", "true");
    document.body.style.overflow = dom.modalOverlay.classList.contains("open") ? "hidden" : "";
    window.setTimeout(() => { if (!dom.drawerOverlay.classList.contains("open")) dom.drawer.innerHTML = ""; }, 240);
    if (restoreFocus && lastFocusedElement instanceof HTMLElement) lastFocusedElement.focus({ preventScroll: true });
  }

  function modalHeader(title, subtitle = "") {
    return `<header class="modal-header"><div class="modal-heading"><h2 id="modal-title">${escapeHtml(title)}</h2>${subtitle ? `<p>${escapeHtml(subtitle)}</p>` : ""}</div><button class="close-btn" type="button" data-action="close-modal" aria-label="Закрыть">×</button></header>`;
  }

  function drawerHeader(title, subtitle = "") {
    return `<header class="drawer-header"><div class="drawer-heading"><h2 id="drawer-title">${escapeHtml(title)}</h2>${subtitle ? `<p>${escapeHtml(subtitle)}</p>` : ""}</div><button class="close-btn" type="button" data-action="close-drawer" aria-label="Закрыть">×</button></header>`;
  }

  function openLeadModal(leadId = null) {
    const lead = leadId ? state.leads.find((item) => item.id === Number(leadId)) : null;
    const value = (key, fallback = "") => escapeHtml(lead?.[key] ?? fallback);
    openModal(`${modalHeader(lead ? `Редактировать заявку #${lead.id}` : "Новая заявка", lead ? "Изменения сразу появятся во всех разделах" : "Заполните основные данные клиента")}
      <form id="lead-form" data-lead-id="${lead?.id || ""}" novalidate>
        <div class="modal-body"><div class="form-grid">
          <div class="form-field"><label for="lead-name">Имя клиента <span class="required">*</span></label><input id="lead-name" name="name" value="${value("name")}" placeholder="Алексей Иванов" autocomplete="name" required><span class="field-error"></span></div>
          <div class="form-field"><label for="lead-phone">Телефон <span class="required">*</span></label><input id="lead-phone" name="phone" value="${value("phone", "+996 ")}" placeholder="+996 555 123 456" autocomplete="tel" required><span class="field-error"></span></div>
          <div class="form-field"><label for="lead-service">Услуга <span class="required">*</span></label><input id="lead-service" name="service" value="${value("service")}" placeholder="Например, полировка кузова" required><span class="field-error"></span></div>
          <div class="form-field"><label for="lead-amount">Стоимость</label><input id="lead-amount" name="amount" type="number" min="0" step="100" value="${value("amount")}" placeholder="0"><span class="field-hint">В валюте рабочего пространства</span></div>
          <div class="form-field"><label for="lead-source">Источник</label><select id="lead-source" name="source">${SOURCES.map((source) => `<option value="${source}" ${(lead?.source || "Instagram") === source ? "selected" : ""}>${source}</option>`).join("")}</select></div>
          <div class="form-field"><label for="lead-status">Статус</label><select id="lead-status" name="status">${Object.entries(STATUS).map(([key, meta]) => `<option value="${key}" ${(lead?.status || "new") === key ? "selected" : ""}>${meta.label}</option>`).join("")}</select></div>
          <div class="form-field span-2"><label for="lead-comment">Комментарий</label><textarea id="lead-comment" name="comment" placeholder="Детали заказа или пожелания клиента">${value("comment")}</textarea></div>
        </div></div>
        <footer class="modal-footer"><button class="secondary-btn" type="button" data-action="close-modal">Отмена</button><button class="primary-btn" type="submit">${lead ? "Сохранить изменения" : "Создать заявку"}</button></footer>
      </form>`);
  }

  function openClientModal() {
    openModal(`${modalHeader("Добавить клиента", "Создайте новую карточку в клиентской базе")}
      <form id="client-form" novalidate><div class="modal-body"><div class="form-grid">
        <div class="form-field"><label for="client-name">Имя клиента <span class="required">*</span></label><input id="client-name" name="name" placeholder="Имя и фамилия" autocomplete="name" required><span class="field-error"></span></div>
        <div class="form-field"><label for="client-phone">Телефон <span class="required">*</span></label><input id="client-phone" name="phone" value="+996 " placeholder="+996 555 123 456" autocomplete="tel" required><span class="field-error"></span></div>
        <div class="form-field"><label for="client-last-order">Последний заказ</label><input id="client-last-order" name="lastOrder" placeholder="Например, полировка"></div>
        <div class="form-field"><label for="client-spent">Потрачено</label><input id="client-spent" name="spent" type="number" min="0" step="100" value="0"></div>
        <div class="form-field span-2"><label for="client-notes">Заметки</label><textarea id="client-notes" name="notes" placeholder="Предпочтения, автомобиль или важные детали"></textarea></div>
      </div></div><footer class="modal-footer"><button class="secondary-btn" type="button" data-action="close-modal">Отмена</button><button class="primary-btn" type="submit">Добавить клиента</button></footer></form>`);
  }

  function toDateTimeLocal(iso) {
    const date = iso ? new Date(iso) : new Date(Date.now() + 3600000);
    const pad = (value) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function openTaskModal(taskId = null) {
    const task = taskId ? state.tasks.find((item) => item.id === Number(taskId)) : null;
    openModal(`${modalHeader(task ? "Редактировать задачу" : "Новая задача", "Добавьте дело и срок выполнения")}
      <form id="task-form" data-task-id="${task?.id || ""}" novalidate><div class="modal-body"><div class="form-grid">
        <div class="form-field span-2"><label for="task-title">Название <span class="required">*</span></label><input id="task-title" name="title" value="${escapeHtml(task?.title || "")}" placeholder="Что нужно сделать?" required><span class="field-error"></span></div>
        <div class="form-field span-2"><label for="task-date">Дата и время <span class="required">*</span></label><input id="task-date" name="dueAt" type="datetime-local" value="${toDateTimeLocal(task?.dueAt)}" required><span class="field-error"></span></div>
      </div></div><footer class="modal-footer"><button class="secondary-btn" type="button" data-action="close-modal">Отмена</button><button class="primary-btn" type="submit">${task ? "Сохранить" : "Создать задачу"}</button></footer></form>`);
  }

  let pendingConfirmAction = null;
  function openConfirm(title, text, buttonLabel, callback) {
    pendingConfirmAction = callback;
    openModal(`${modalHeader(title)}<div class="modal-body"><div class="confirm-visual">!</div><div class="confirm-copy"><h3>${escapeHtml(title)}</h3><p>${escapeHtml(text)}</p></div></div><footer class="modal-footer"><button class="secondary-btn" type="button" data-action="close-modal">Отмена</button><button class="danger-btn" type="button" data-action="confirm-danger">${escapeHtml(buttonLabel)}</button></footer>`, true);
  }

  function openLeadDrawer(leadId, addOpenedEvent = true) {
    const lead = state.leads.find((item) => item.id === Number(leadId));
    if (!lead) return;
    if (addOpenedEvent) {
      const lastOpened = [...(lead.history || [])].reverse().find((entry) => entry.type === "opened");
      if (!lastOpened || Date.now() - new Date(lastOpened.at).getTime() > 300000) {
        lead.history ||= [];
        lead.history.push({ at: new Date().toISOString(), type: "opened", text: "Менеджер открыл заявку" });
        saveState();
      }
    }
    openDrawer(leadDrawerTemplate(lead));
  }

  function leadDrawerTemplate(lead) {
    const history = [...(lead.history || [])].sort((a, b) => new Date(b.at) - new Date(a.at));
    const digits = normalizePhone(lead.phone);
    return `${drawerHeader(`#${lead.id}`, "Карточка заявки")}
      <div class="drawer-body">
        <div class="drawer-lead-head"><span class="large-avatar">${escapeHtml(initials(lead.name))}</span><div class="drawer-person"><strong>${escapeHtml(lead.name)}</strong><span>${escapeHtml(lead.phone)}</span></div><button class="mini-btn" type="button" data-action="edit-lead" data-lead-id="${lead.id}">Редактировать</button></div>
        <div class="quick-actions"><a class="quick-action" href="tel:${digits}"><span>☎</span>Позвонить</a><a class="quick-action" href="https://wa.me/${digits}" target="_blank" rel="noopener"><span>W</span>WhatsApp</a><button class="quick-action" type="button" data-action="telegram-contact" data-phone="${escapeHtml(lead.phone)}"><span>T</span>Telegram</button></div>
        <div class="info-grid">
          <div class="info-item"><span>Услуга</span><strong>${escapeHtml(lead.service)}</strong></div><div class="info-item"><span>Стоимость</span><strong>${formatCurrency(lead.amount)}</strong></div>
          <div class="info-item"><span>Источник</span><strong>${escapeHtml(lead.source)}</strong></div><div class="info-item"><span>Создана</span><strong>${formatLongDate(lead.createdAt)}</strong></div>
        </div>
        <section class="drawer-section"><div class="drawer-section-head"><h3>Статус</h3>${statusBadge(lead.status)}</div><select class="drawer-status-select" id="drawer-lead-status" data-lead-id="${lead.id}" aria-label="Изменить статус заявки">${Object.entries(STATUS).map(([key, meta]) => `<option value="${key}" ${lead.status === key ? "selected" : ""}>${meta.label}</option>`).join("")}</select></section>
        <section class="drawer-section"><div class="drawer-section-head"><h3>Комментарий</h3></div><div class="drawer-note">${lead.comment ? escapeHtml(lead.comment) : "Комментарий пока не добавлен."}</div></section>
        <section class="drawer-section"><div class="drawer-section-head"><h3>История</h3><span class="funnel-rate">${history.length} событий</span></div><div class="timeline">${history.map((entry) => `<div class="timeline-item"><span class="timeline-dot"></span><span class="timeline-time">${new Date(entry.at).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}</span><span class="timeline-copy">${escapeHtml(entry.text)}</span></div>`).join("")}</div></section>
        <div class="settings-actions"><button class="danger-btn" type="button" data-action="delete-lead" data-lead-id="${lead.id}">Удалить заявку</button></div>
      </div>`;
  }

  function openClientDrawer(clientId) {
    const client = state.clients.find((item) => item.id === Number(clientId));
    if (!client) return;
    const linkedLeads = state.leads.filter((lead) => normalizePhone(lead.phone) === normalizePhone(client.phone));
    const storedOrders = Array.isArray(client.ordersHistory) ? client.ordersHistory : [];
    const orders = storedOrders.length ? storedOrders : linkedLeads.map((lead) => ({ service: lead.service, amount: lead.amount, at: lead.createdAt }));
    const displayOrders = orders.length ? orders : [{ service: client.lastOrder || "Заказ", amount: client.spent, at: client.lastContact }];
    const average = client.orders ? Math.round(client.spent / client.orders) : 0;
    const digits = normalizePhone(client.phone);
    openDrawer(`${drawerHeader("Профиль клиента", `Клиент #${client.id}`)}
      <div class="drawer-body"><div class="drawer-lead-head"><span class="large-avatar">${escapeHtml(initials(client.name))}</span><div class="drawer-person"><strong>${escapeHtml(client.name)}</strong><span>${escapeHtml(client.phone)}</span></div></div>
        <div class="quick-actions"><a class="quick-action" href="tel:${digits}"><span>☎</span>Позвонить</a><a class="quick-action" href="https://wa.me/${digits}" target="_blank" rel="noopener"><span>W</span>WhatsApp</a><button class="quick-action" type="button" data-action="telegram-contact" data-phone="${escapeHtml(client.phone)}"><span>T</span>Telegram</button></div>
        <div class="client-metrics"><div class="client-metric"><strong>${client.orders}</strong><span>заказа</span></div><div class="client-metric"><strong>${formatCurrency(client.spent)}</strong><span>потрачено</span></div><div class="client-metric"><strong>${formatCurrency(average)}</strong><span>средний чек</span></div></div>
        <section class="drawer-section"><div class="drawer-section-head"><h3>История заказов</h3><span class="funnel-rate">${client.orders} всего</span></div><div class="order-history">${displayOrders.slice(0, 8).map((order) => `<div class="order-row"><div class="order-main"><strong>${escapeHtml(order.service)}</strong><span>${formatDate(order.at, false)}</span></div><div><div class="order-amount">${formatCurrency(order.amount)}</div><div class="order-date">Выполнено</div></div></div>`).join("")}</div></section>
        <section class="drawer-section"><div class="drawer-section-head"><h3>Заметки клиента</h3></div><textarea class="note-editor" id="client-note-editor" data-client-id="${client.id}" placeholder="Добавьте важную информацию о клиенте">${escapeHtml(client.notes || "")}</textarea><div style="display:flex;justify-content:flex-end;margin-top:8px"><button class="secondary-btn" type="button" data-action="save-client-note" data-client-id="${client.id}">Сохранить заметку</button></div></section>
      </div>`);
  }

  function refreshCurrentPage() {
    switch (ui.page) {
      case "leads": renderLeads(); break;
      case "clients": renderClients(); break;
      case "tasks": renderTasks(); break;
      case "analytics": renderAnalytics(); break;
      case "integrations": renderIntegrations(); break;
      case "settings": renderSettings(); break;
      default: renderOverview();
    }
  }

  function updateLeadStatus(leadId, nextStatus, message = true) {
    const lead = state.leads.find((item) => item.id === Number(leadId));
    if (!lead || !STATUS[nextStatus] || lead.status === nextStatus) return false;
    const previous = lead.status;
    lead.status = nextStatus;
    lead.history ||= [];
    lead.history.push({ at: new Date().toISOString(), type: "status", text: `Статус изменён: ${STATUS[previous].label} → ${STATUS[nextStatus].label}` });
    notify(`${lead.name}: ${STATUS[previous].label} → ${STATUS[nextStatus].label}`);
    saveState();
    if (message) toast("Статус изменён", `${lead.name} — ${STATUS[nextStatus].label}`);
    return true;
  }

  function deleteLead(leadId) {
    const lead = state.leads.find((item) => item.id === Number(leadId));
    if (!lead) return;
    openConfirm("Удалить заявку?", `Заявка #${lead.id} клиента ${lead.name} будет удалена без возможности восстановления.`, "Удалить заявку", () => {
      state.leads = state.leads.filter((item) => item.id !== lead.id);
      saveState();
      closeDrawer(false);
      refreshCurrentPage();
      toast("Заявка удалена", `#${lead.id} удалена из CRM`);
    });
  }

  function setFieldError(input, message) {
    const field = input.closest(".form-field");
    field?.classList.toggle("invalid", Boolean(message));
    const error = $(".field-error", field);
    if (error) error.textContent = message;
  }

  function validateRequired(input, message) {
    const valid = Boolean(input.value.trim());
    setFieldError(input, valid ? "" : message);
    return valid;
  }

  function submitLeadForm(form) {
    const name = form.elements.name;
    const phone = form.elements.phone;
    const service = form.elements.service;
    const validName = validateRequired(name, "Укажите имя клиента");
    const validPhone = normalizePhone(phone.value).length >= 9;
    setFieldError(phone, validPhone ? "" : "Проверьте номер телефона");
    const validService = validateRequired(service, "Укажите услугу");
    if (!validName || !validPhone || !validService) return;

    const data = Object.fromEntries(new FormData(form));
    const editingId = Number(form.dataset.leadId) || null;
    if (editingId) {
      const lead = state.leads.find((item) => item.id === editingId);
      if (!lead) return;
      const previousStatus = lead.status;
      Object.assign(lead, { name: data.name.trim(), phone: data.phone.trim(), service: data.service.trim(), amount: Number(data.amount) || 0, source: data.source, status: data.status, comment: data.comment.trim() });
      lead.history ||= [];
      lead.history.push({ at: new Date().toISOString(), type: "edited", text: "Данные заявки обновлены" });
      if (previousStatus !== data.status) lead.history.push({ at: new Date().toISOString(), type: "status", text: `Статус изменён: ${STATUS[previousStatus].label} → ${STATUS[data.status].label}` });
      saveState();
      closeModal(false);
      refreshCurrentPage();
      openLeadDrawer(editingId, false);
      toast("Изменения сохранены", `Заявка #${editingId} обновлена`);
    } else {
      const id = Math.max(1000, ...state.leads.map((lead) => lead.id)) + 1;
      const createdAt = new Date().toISOString();
      const lead = { id, name: data.name.trim(), phone: data.phone.trim(), service: data.service.trim(), amount: Number(data.amount) || 0, source: data.source, status: data.status, comment: data.comment.trim(), createdAt, history: createHistory(data.status, createdAt) };
      state.leads.unshift(lead);
      notify(`Новая заявка от ${lead.name}`);
      saveState();
      closeModal();
      refreshCurrentPage();
      toast("Заявка успешно создана", `#${id} добавлена в FLOW CRM`);
    }
  }

  function submitClientForm(form) {
    const name = form.elements.name;
    const phone = form.elements.phone;
    const validName = validateRequired(name, "Укажите имя клиента");
    const validPhone = normalizePhone(phone.value).length >= 9;
    setFieldError(phone, validPhone ? "" : "Проверьте номер телефона");
    const duplicate = state.clients.some((client) => normalizePhone(client.phone) === normalizePhone(phone.value));
    if (duplicate) setFieldError(phone, "Клиент с таким телефоном уже есть");
    if (!validName || !validPhone || duplicate) return;
    const data = Object.fromEntries(new FormData(form));
    const id = Math.max(0, ...state.clients.map((client) => client.id)) + 1;
    state.clients.unshift({ id, name: data.name.trim(), phone: data.phone.trim(), lastOrder: data.lastOrder.trim() || "—", orders: Number(data.spent) > 0 ? 1 : 0, spent: Number(data.spent) || 0, lastContact: new Date().toISOString(), createdAt: new Date().toISOString(), notes: data.notes.trim(), ordersHistory: [] });
    notify(`Добавлен новый клиент: ${data.name.trim()}`);
    saveState();
    closeModal();
    refreshCurrentPage();
    toast("Клиент добавлен", `${data.name.trim()} теперь в клиентской базе`);
  }

  function submitTaskForm(form) {
    const title = form.elements.title;
    const dueAt = form.elements.dueAt;
    const validTitle = validateRequired(title, "Укажите название задачи");
    const validDate = Boolean(dueAt.value) && !Number.isNaN(new Date(dueAt.value).getTime());
    setFieldError(dueAt, validDate ? "" : "Укажите дату и время");
    if (!validTitle || !validDate) return;
    const editingId = Number(form.dataset.taskId) || null;
    if (editingId) {
      const task = state.tasks.find((item) => item.id === editingId);
      if (!task) return;
      task.title = title.value.trim();
      task.dueAt = new Date(dueAt.value).toISOString();
      toast("Задача обновлена", task.title);
    } else {
      const id = Math.max(0, ...state.tasks.map((task) => task.id)) + 1;
      state.tasks.unshift({ id, title: title.value.trim(), dueAt: new Date(dueAt.value).toISOString(), completed: false, createdAt: new Date().toISOString() });
      toast("Задача создана", title.value.trim());
    }
    saveState();
    closeModal();
    renderTasks();
  }

  function renderGlobalSearch(query = "") {
    const normalized = query.trim().toLowerCase();
    if (!normalized) {
      dom.searchResults.innerHTML = `<div class="search-group-title">Быстрый поиск</div><div class="empty-state compact"><div><span class="empty-state-icon">⌕</span><h3>Найдите что угодно</h3><p>Введите имя, телефон, ID заявки или услугу</p></div></div>`;
      return;
    }
    const clients = state.clients.filter((client) => [client.name, client.phone].some((value) => String(value).toLowerCase().includes(normalized))).slice(0, 5);
    const leads = state.leads.filter((lead) => [lead.name, lead.phone, lead.service, String(lead.id)].some((value) => String(value).toLowerCase().includes(normalized))).slice(0, 5);
    if (!clients.length && !leads.length) {
      dom.searchResults.innerHTML = emptyState("Ничего не найдено", `Нет результатов по запросу «${query}»`, "", true);
      return;
    }
    dom.searchResults.innerHTML = `${clients.length ? `<div class="search-group-title">Клиенты</div>${clients.map((client) => `<button class="search-result" type="button" data-action="search-client" data-client-id="${client.id}"><span class="search-result-avatar">${escapeHtml(initials(client.name))}</span><span class="search-result-copy"><strong>${escapeHtml(client.name)}</strong><small>${escapeHtml(client.phone)}</small></span><span class="search-result-arrow">→</span></button>`).join("")}` : ""}
      ${leads.length ? `<div class="search-group-title">Заявки</div>${leads.map((lead) => `<button class="search-result" type="button" data-action="search-lead" data-lead-id="${lead.id}"><span class="search-result-avatar">#</span><span class="search-result-copy"><strong>#${lead.id} — ${escapeHtml(lead.name)}</strong><small>${escapeHtml(lead.service)} · ${formatCurrency(lead.amount)}</small></span><span class="search-result-arrow">→</span></button>`).join("")}` : ""}`;
  }

  function openSearch() {
    dom.notificationsPopover.classList.remove("open");
    dom.notificationsPopover.setAttribute("aria-hidden", "true");
    dom.searchPopover.classList.add("open");
    dom.searchPopover.setAttribute("aria-hidden", "false");
    renderGlobalSearch(dom.searchInput.value);
    requestAnimationFrame(() => dom.searchInput.focus());
  }

  function closePopovers() {
    [dom.searchPopover, dom.notificationsPopover].forEach((popover) => {
      popover.classList.remove("open");
      popover.setAttribute("aria-hidden", "true");
    });
  }

  function copyText(text) {
    if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    return Promise.resolve(fallbackCopy(text));
  }

  function fallbackCopy(text) {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    textarea.select();
    try { document.execCommand("copy"); } catch (_) { /* старые браузеры */ }
    textarea.remove();
  }

  function closeMobileMenu() {
    dom.shell.classList.remove("mobile-menu-open");
  }

  function saveUIPreferences() {
    try { localStorage.setItem(UI_KEY, JSON.stringify({ collapsed: dom.shell.classList.contains("sidebar-collapsed") })); } catch (_) { /* необязательно */ }
  }

  function loadUIPreferences() {
    try {
      const preferences = JSON.parse(localStorage.getItem(UI_KEY) || "{}");
      dom.shell.classList.toggle("sidebar-collapsed", Boolean(preferences.collapsed));
    } catch (_) { /* используем раскрытое меню */ }
  }

  function handleAction(actionElement, event) {
    const action = actionElement.dataset.action;
    switch (action) {
      case "new-lead": openLeadModal(); break;
      case "edit-lead": closeDrawer(false); openLeadModal(actionElement.dataset.leadId); break;
      case "delete-lead": deleteLead(actionElement.dataset.leadId); break;
      case "open-lead": openLeadDrawer(actionElement.dataset.leadId); break;
      case "new-client": openClientModal(); break;
      case "open-client": openClientDrawer(actionElement.dataset.clientId); break;
      case "new-task": openTaskModal(); break;
      case "edit-task": openTaskModal(actionElement.dataset.taskId); break;
      case "delete-task": {
        const task = state.tasks.find((item) => item.id === Number(actionElement.dataset.taskId));
        if (task) openConfirm("Удалить задачу?", `Задача «${task.title}» будет удалена.`, "Удалить задачу", () => { state.tasks = state.tasks.filter((item) => item.id !== task.id); saveState(); renderTasks(); toast("Задача удалена", task.title); });
        break;
      }
      case "toggle-task": {
        const task = state.tasks.find((item) => item.id === Number(actionElement.dataset.taskId));
        if (task) { task.completed = !task.completed; task.completedAt = task.completed ? new Date().toISOString() : null; saveState(); renderTasks(); toast(task.completed ? "Задача выполнена" : "Задача возвращена", task.title); }
        break;
      }
      case "close-modal": closeModal(); break;
      case "close-drawer": closeDrawer(); break;
      case "confirm-danger": {
        const callback = pendingConfirmAction;
        pendingConfirmAction = null;
        closeModal(false);
        callback?.();
        break;
      }
      case "dashboard-period": ui.dashboardPeriod = actionElement.dataset.period; renderOverview(); break;
      case "dashboard-chart": ui.dashboardChart = actionElement.dataset.chart; renderOverview(); break;
      case "analytics-period": ui.analyticsPeriod = actionElement.dataset.period; renderAnalytics(); break;
      case "leads-view": ui.leadsView = actionElement.dataset.view; ui.leadPage = 1; renderLeads(); break;
      case "lead-page": ui.leadPage = Number(actionElement.dataset.page); renderLeads(); break;
      case "client-page": ui.clientPage = Number(actionElement.dataset.page); renderClients(); break;
      case "sort-leads": {
        const sort = actionElement.dataset.sort;
        if (!sort) break;
        if (ui.leadSort === sort) ui.leadSortDirection = ui.leadSortDirection === "asc" ? "desc" : "asc";
        else { ui.leadSort = sort; ui.leadSortDirection = "asc"; }
        renderLeads();
        break;
      }
      case "clear-lead-filters": ui.leadSearch = ""; ui.leadStatus = "all"; ui.leadSource = "all"; ui.leadPage = 1; renderLeads(); break;
      case "clear-client-search": ui.clientSearch = ""; ui.clientPage = 1; renderClients(); break;
      case "go-leads": window.location.hash = "leads"; break;
      case "settings-tab": ui.settingsTab = actionElement.dataset.tab; renderSettings(); break;
      case "toggle-notification-setting": {
        const key = actionElement.dataset.setting;
        state.settings.notifications[key] = !state.settings.notifications[key];
        saveState(); renderSettings(); toast("Настройки сохранены");
        break;
      }
      case "reset-demo": openConfirm("Сбросить демо-данные?", "Все ваши изменения в этом браузере будут удалены и заменены исходными данными FLOW CRM.", "Сбросить данные", () => { state = createDemoData(); saveState(); ui.leadSearch = ""; ui.clientSearch = ""; ui.leadPage = 1; ui.clientPage = 1; renderSettings(); toast("Демо-данные восстановлены", "FLOW CRM вернулась к исходному состоянию"); }); break;
      case "integration-demo": toast("Требуется подключение", `${actionElement.dataset.integration}: в MVP доступен только демо-интерфейс`); break;
      case "mark-read": state.notifications.forEach((notification) => { notification.read = true; }); saveState(); renderNotifications(); toast("Уведомления прочитаны"); break;
      case "search-client": closePopovers(); openClientDrawer(actionElement.dataset.clientId); break;
      case "search-lead": closePopovers(); openLeadDrawer(actionElement.dataset.leadId); break;
      case "telegram-contact": copyText(actionElement.dataset.phone).then(() => toast("Телефон скопирован", "Вставьте номер в поиск Telegram")); break;
      case "save-client-note": {
        const client = state.clients.find((item) => item.id === Number(actionElement.dataset.clientId));
        const editor = $("#client-note-editor");
        if (client && editor) { client.notes = editor.value.trim(); saveState(); toast("Заметка сохранена", client.name); }
        break;
      }
      case "select-lead": {
        event.stopPropagation();
        const id = Number(actionElement.dataset.leadId);
        actionElement.checked ? ui.selectedLeadIds.add(id) : ui.selectedLeadIds.delete(id);
        break;
      }
      case "select-page-leads": {
        event.stopPropagation();
        const perPage = 8;
        const items = filterLeads().slice((ui.leadPage - 1) * perPage, ui.leadPage * perPage);
        items.forEach((lead) => actionElement.checked ? ui.selectedLeadIds.add(lead.id) : ui.selectedLeadIds.delete(lead.id));
        renderLeads();
        break;
      }
      case "open-profile": window.location.hash = "settings"; ui.settingsTab = "user"; if (ui.page === "settings") renderSettings(); break;
      default: break;
    }
  }

  function bindEvents() {
    window.addEventListener("hashchange", renderPage);
    $("#sidebar-collapse").addEventListener("click", () => { dom.shell.classList.toggle("sidebar-collapsed"); saveUIPreferences(); });
    $("#menu-btn").addEventListener("click", () => dom.shell.classList.add("mobile-menu-open"));
    $("#mobile-backdrop").addEventListener("click", closeMobileMenu);
    $("#global-search-trigger").addEventListener("click", openSearch);
    $("#notifications-btn").addEventListener("click", (event) => {
      event.stopPropagation();
      dom.searchPopover.classList.remove("open");
      const open = !dom.notificationsPopover.classList.contains("open");
      dom.notificationsPopover.classList.toggle("open", open);
      dom.notificationsPopover.setAttribute("aria-hidden", String(!open));
    });

    document.addEventListener("click", (event) => {
      const actionElement = event.target.closest("[data-action]");
      if (actionElement) handleAction(actionElement, event);
      if (!event.target.closest(".global-search-wrap") && !event.target.closest("#search-popover")) {
        dom.searchPopover.classList.remove("open");
        dom.searchPopover.setAttribute("aria-hidden", "true");
      }
      if (!event.target.closest("#notifications-btn") && !event.target.closest("#notifications-popover")) {
        dom.notificationsPopover.classList.remove("open");
        dom.notificationsPopover.setAttribute("aria-hidden", "true");
      }
    });

    dom.modalOverlay.addEventListener("click", (event) => { if (event.target === dom.modalOverlay) closeModal(); });
    dom.drawerOverlay.addEventListener("click", (event) => { if (event.target === dom.drawerOverlay) closeDrawer(); });

    document.addEventListener("submit", (event) => {
      event.preventDefault();
      const form = event.target;
      if (form.id === "lead-form") submitLeadForm(form);
      else if (form.id === "client-form") submitClientForm(form);
      else if (form.id === "task-form") submitTaskForm(form);
      else if (form.id === "company-form") {
        const data = Object.fromEntries(new FormData(form));
        state.settings.company = data.company.trim(); state.settings.phone = data.phone.trim(); state.settings.email = data.email.trim(); state.settings.city = data.city.trim();
        saveState(); renderSettings(); toast("Изменения сохранены", "Данные компании обновлены");
      } else if (form.id === "user-form") {
        const data = Object.fromEntries(new FormData(form));
        state.settings.userName = data.userName.trim(); state.settings.userEmail = data.userEmail.trim();
        saveState(); renderSettings(); toast("Профиль обновлён");
      } else if (form.id === "currency-form") {
        state.settings.currency = new FormData(form).get("currency");
        saveState(); renderSettings(); toast("Валюта сохранена", state.settings.currency === "KGS" ? "Суммы отображаются в сомах" : "Суммы отображаются в долларах");
      }
    });

    document.addEventListener("input", (event) => {
      if (event.target.id === "global-search-input") renderGlobalSearch(event.target.value);
      if (event.target.id === "lead-search") {
        ui.leadSearch = event.target.value; ui.leadPage = 1;
        const surface = $("#leads-surface");
        if (surface) { const filtered = filterLeads(); surface.innerHTML = ui.leadsView === "kanban" ? kanbanTemplate(filtered) : leadsTableTemplate(filtered); }
      }
      if (event.target.id === "client-search") {
        ui.clientSearch = event.target.value; ui.clientPage = 1;
        const caret = event.target.selectionStart;
        renderClients();
        requestAnimationFrame(() => { const input = $("#client-search"); if (input) { input.focus(); input.setSelectionRange(caret, caret); } });
      }
      if (event.target.closest(".form-field")) setFieldError(event.target, "");
    });

    document.addEventListener("change", (event) => {
      if (event.target.id === "lead-status-filter") { ui.leadStatus = event.target.value; ui.leadPage = 1; renderLeads(); }
      if (event.target.id === "lead-source-filter") { ui.leadSource = event.target.value; ui.leadPage = 1; renderLeads(); }
      if (event.target.id === "drawer-lead-status") {
        const id = Number(event.target.dataset.leadId);
        if (updateLeadStatus(id, event.target.value)) { refreshCurrentPage(); openLeadDrawer(id, false); }
      }
    });

    document.addEventListener("keydown", (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); openSearch(); return; }
      if (event.key === "Escape") {
        if (dom.modalOverlay.classList.contains("open")) closeModal();
        else if (dom.drawerOverlay.classList.contains("open")) closeDrawer();
        else closePopovers();
        return;
      }
      if ((event.key === "Enter" || event.key === " ") && event.target.matches("tr[data-action], article[data-action]")) {
        event.preventDefault(); handleAction(event.target, event);
      }
      if (event.key === "Tab") trapFocus(event);
    });

    dom.main.addEventListener("dragstart", (event) => {
      const card = event.target.closest(".lead-card");
      if (!card) return;
      ui.draggingLeadId = Number(card.dataset.leadId);
      card.classList.add("dragging");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", card.dataset.leadId);
    });
    dom.main.addEventListener("dragover", (event) => {
      const column = event.target.closest(".kanban-column");
      if (!column) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      $$(".kanban-column.drag-over", dom.main).forEach((item) => { if (item !== column) item.classList.remove("drag-over"); });
      column.classList.add("drag-over");
    });
    dom.main.addEventListener("dragleave", (event) => {
      const column = event.target.closest(".kanban-column");
      if (column && !column.contains(event.relatedTarget)) column.classList.remove("drag-over");
    });
    dom.main.addEventListener("drop", (event) => {
      const column = event.target.closest(".kanban-column");
      if (!column) return;
      event.preventDefault();
      const id = Number(event.dataTransfer.getData("text/plain")) || ui.draggingLeadId;
      column.classList.remove("drag-over");
      if (updateLeadStatus(id, column.dataset.status)) renderLeads();
    });
    dom.main.addEventListener("dragend", () => {
      ui.draggingLeadId = null;
      $$(".lead-card.dragging, .kanban-column.drag-over", dom.main).forEach((item) => item.classList.remove("dragging", "drag-over"));
    });

    window.addEventListener("resize", () => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        if (ui.page === "overview") drawOverviewChart();
        if (ui.page === "analytics") drawAnalyticsChart();
      }, 150);
    });
  }

  function trapFocus(event) {
    const container = dom.modalOverlay.classList.contains("open") ? dom.modal : dom.drawerOverlay.classList.contains("open") ? dom.drawer : null;
    if (!container) return;
    const focusable = $$("button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])", container).filter((element) => element.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  function init() {
    loadUIPreferences();
    bindEvents();
    updateShell();
    renderGlobalSearch();
    window.setTimeout(() => {
      dom.shell.classList.remove("is-loading");
      renderPage();
    }, 420);
  }

  init();
})();
