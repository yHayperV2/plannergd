// =====================================================
// STATE
// =====================================================
let usersList = [];
let currentUser = null;
let authToken = localStorage.getItem('uber_finance_auth_token') || null;

// =====================================================
// SUPABASE CLIENT INIT
// =====================================================
let SUPABASE_URL = localStorage.getItem('supabase_url') || 'https://fogmkzbiyukyvbidwuuo.supabase.co';
let SUPABASE_KEY = localStorage.getItem('supabase_anon_key') || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZvZ21remJpeXVreXZiaWR3dXVvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ4MTc0NTAsImV4cCI6MjEwMDM5MzQ1MH0.WE3FzYhgVk9Jm3EzKLP5Drw2WBl176VVk1rSu5KERFI';
let supabaseClient = null;

if (SUPABASE_URL && SUPABASE_KEY && window.supabase) {
    supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
}

window.configurarSupabase = function() {
    const url = prompt('Cole a URL do Supabase (Project URL):', SUPABASE_URL);
    if (!url) return;
    const key = prompt('Cole a chave ANON do Supabase (API Key):', SUPABASE_KEY);
    if (!key) return;
    localStorage.setItem('supabase_url', url.trim());
    localStorage.setItem('supabase_anon_key', key.trim());
    alert('Supabase configurado! A página será recarregada.');
    location.reload();
};

// Uber state
let uberEntries = [];
let personalEntries = [];
let editingUberId = null;
let editingPersonalId = null;
let uberSettings = {
    currency: 'PYG',
    monthlyExpenseLimit: 0,
    backupEmail: '',
    emailjsServiceId: '',
    emailjsTemplateId: '',
    emailjsPublicKey: ''
};

// Roupas state
let estoqueItems = [];
let comprasEntries = [];
let vendasEntries = [];
let editingEstoqueId = null;
let editingCompraId = null;
let editingVendaId = null;
let roupasSettings = {
    backupEmail: '',
    emailjsServiceId: '',
    emailjsTemplateId: '',
    emailjsPublicKey: ''
};

// Gráfica Rápida state
let graficaProdutos = [];
let graficaVendas = [];
let graficaCart = [];
let graficaDespesasOp = [];
let graficaDespesasPessoais = [];
let graficaPrices = {};
let editingGraficaProdutoId = null;
let editingGraficaDespesaOpId = null;
let editingGraficaDespesaPessoalId = null;
let graficaSettings = {
    backupEmail: '',
    emailjsServiceId: '',
    emailjsTemplateId: '',
    emailjsPublicKey: ''
};

// Charts
let charts = {};

// =====================================================
// CURRENCY CONFIGS
// =====================================================
const CURRENCY_CONFIG = {
    PYG: { symbol: '₲', locale: 'es-PY', decimals: 0 },
    BRL: { symbol: 'R$', locale: 'pt-BR', decimals: 2 },
    USD: { symbol: '$', locale: 'en-US', decimals: 2 },
    EUR: { symbol: '€', locale: 'de-DE', decimals: 2 }
};

// Default currency for roupas app (BRL)
const ROUPAS_CURRENCY = CURRENCY_CONFIG.BRL;

// =====================================================
// HELPERS
// =====================================================
function fmt(value, currencyCode) {
    const cfg = CURRENCY_CONFIG[currencyCode || uberSettings.currency] || CURRENCY_CONFIG.PYG;
    const n = parseFloat(value || 0);
    if (cfg.decimals === 0) {
        return `${cfg.symbol} ${Math.round(n).toLocaleString(cfg.locale)}`;
    }
    return `${cfg.symbol} ${n.toLocaleString(cfg.locale, { minimumFractionDigits: cfg.decimals, maximumFractionDigits: cfg.decimals })}`;
}

function fmtR(value) { return fmt(value, 'BRL'); }

function dateBR(d) {
    if (!d) return '';
    const [y, m, day] = d.split('-');
    return `${day}/${m}/${y}`;
}

function monthKey(d) { return d ? d.substring(0, 7) : ''; }

function todayISO() { return new Date().toISOString().split('T')[0]; }

function userKey(base) {
    return currentUser ? `${base}_${currentUser.username}` : base;
}

function updateCurrencySymbols() {
    const sym = (CURRENCY_CONFIG[uberSettings.currency] || CURRENCY_CONFIG.PYG).symbol;
    document.querySelectorAll('.currency-symbol').forEach(el => el.textContent = sym);
}

// Toast notification helper
function showToast(msg, type = 'info') {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    const iconMap = {
        success: 'fa-circle-check',
        error: 'fa-circle-exclamation',
        info: 'fa-circle-info',
        warning: 'fa-triangle-exclamation'
    };
    toast.innerHTML = `<i class="fa-solid ${iconMap[type] || 'fa-circle-info'}"></i><span>${msg}</span><button onclick="this.parentElement.remove()">&times;</button>`;
    container.appendChild(toast);
    setTimeout(() => toast.classList.add('show'), 10);
    setTimeout(() => {
        toast.classList.remove('show');
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

// =====================================================
// BACKUP & EMAIL SYSTEM
// =====================================================
function generateBackupObject() {
    const isUber = currentUser ? currentUser.accountType === 'uber' : true;
    return {
        system: "Controle Financeiro",
        version: "2.0",
        user: currentUser ? currentUser.username : 'guest',
        userName: currentUser ? currentUser.name : 'Convidado',
        accountType: currentUser ? currentUser.accountType : 'uber',
        backupDate: todayISO(),
        timestamp: new Date().toISOString(),
        settings: isUber ? uberSettings : roupasSettings,
        data: isUber ? { uberEntries, personalEntries } : { estoqueItems, comprasEntries, vendasEntries }
    };
}

function downloadJSONBackup(backupObj) {
    const obj = backupObj || generateBackupObject();
    const str = JSON.stringify(obj, null, 2);
    const filename = `backup_financeiro_${currentUser ? currentUser.accountType : 'app'}_${todayISO()}.json`;
    const blob = new Blob([str], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

function saveInternalBackup(backupObj) {
    const key = userKey('internal_backups_list');
    let list = [];
    try {
        const raw = localStorage.getItem(key);
        if (raw) list = JSON.parse(raw);
    } catch(e) {}
    
    // Manter no máximo 30 snapshots diários salvos internamente no navegador
    list = list.filter(b => b.backupDate !== backupObj.backupDate);
    list.unshift({
        backupDate: backupObj.backupDate,
        timestamp: backupObj.timestamp,
        accountType: backupObj.accountType,
        summary: backupObj.accountType === 'uber' 
            ? `${uberEntries.length} lançamentos Uber | ${personalEntries.length} despesas Casa`
            : `${estoqueItems.length} produtos em estoque | ${vendasEntries.length} vendas`,
        data: backupObj
    });

    if (list.length > 30) list = list.slice(0, 30);
    localStorage.setItem(key, JSON.stringify(list));
}

function checkAndRunDailyBackup() {
    if (!currentUser) return;
    const lastKey = userKey('last_daily_backup_date');
    const lastBackupDate = localStorage.getItem(lastKey);
    const today = todayISO();

    if (lastBackupDate !== today) {
        // Salva cópia de segurança internamente no navegador (sem forçar download de arquivo)
        const backupObj = generateBackupObject();
        localStorage.setItem(userKey(`backup_snapshot_${today}`), JSON.stringify(backupObj));
        saveInternalBackup(backupObj);
        localStorage.setItem(lastKey, today);

        // Se o usuário configurou o EmailJS, envia o backup por e-mail automaticamente
        const st = currentUser.accountType === 'uber' ? uberSettings : roupasSettings;
        if (st.backupEmail && st.emailjsServiceId && st.emailjsTemplateId && st.emailjsPublicKey) {
            sendEmailBackup(false);
        }
    }
}

async function sendEmailBackup(manualTest = false) {
    if (!currentUser) return;
    const isUber = currentUser.accountType === 'uber';
    const st = isUber ? uberSettings : roupasSettings;

    if (!st.backupEmail || !st.emailjsServiceId || !st.emailjsTemplateId || !st.emailjsPublicKey) {
        if (manualTest) {
            showToast('Preencha todas as chaves do EmailJS nas configurações primeiro!', 'warning');
        }
        return;
    }

    if (typeof emailjs === 'undefined') {
        if (manualTest) showToast('Biblioteca EmailJS não carregou. Verifique sua conexão.', 'error');
        return;
    }

    try {
        emailjs.init(st.emailjsPublicKey);

        let summaryText = '';
        if (isUber) {
            summaryText = `Lançamentos Uber: ${uberEntries.length} | Despesas Casa: ${personalEntries.length}`;
        } else {
            summaryText = `Itens Estoque: ${estoqueItems.length} | Compras: ${comprasEntries.length} | Vendas: ${vendasEntries.length}`;
        }

        const templateParams = {
            to_email: st.backupEmail,
            from_name: currentUser.name,
            backup_date: dateBR(todayISO()),
            account_type: isUber ? 'Motorista Uber' : 'Vendedor de Roupas',
            summary: summaryText,
            backup_json: JSON.stringify(generateBackupObject())
        };

        if (manualTest) showToast('Enviando e-mail de teste...', 'info');

        await emailjs.send(st.emailjsServiceId, st.emailjsTemplateId, templateParams);

        showToast(manualTest ? '✅ E-mail de teste enviado com sucesso!' : '📧 Backup diário enviado por e-mail!', 'success');
    } catch(err) {
        console.error('Erro EmailJS:', err);
        showToast(`❌ Erro ao enviar e-mail: ${err.text || err.message || 'Verifique as chaves'}`, 'error');
    }
}

// =====================================================
// INIT
// =====================================================
document.addEventListener('DOMContentLoaded', () => {
    loadUsers();
    setupAuthUI();

    const saved = localStorage.getItem('uber_finance_logged_user');
    if (saved) {
        try {
            currentUser = JSON.parse(saved);
            if (!currentUser || !currentUser.accountType) {
                localStorage.removeItem('uber_finance_logged_user');
                currentUser = null;
                showAuth();
            } else {
                startSession();
            }
        } catch(err) {
            localStorage.removeItem('uber_finance_logged_user');
            showAuth();
        }
    } else {
        showAuth();
    }
});

// =====================================================
// AUTH
// =====================================================
function setupAuthUI() {
    const loginTabBtn = document.getElementById('authTabLoginBtn');
    const regTabBtn = document.getElementById('authTabRegisterBtn');
    const loginForm = document.getElementById('loginForm');
    const registerForm = document.getElementById('registerForm');

    loginTabBtn.onclick = () => {
        loginTabBtn.classList.add('active');
        regTabBtn.classList.remove('active');
        loginForm.classList.remove('hidden');
        registerForm.classList.add('hidden');
        clearAuthErrors();
    };
    regTabBtn.onclick = () => {
        regTabBtn.classList.add('active');
        loginTabBtn.classList.remove('active');
        registerForm.classList.remove('hidden');
        loginForm.classList.add('hidden');
        clearAuthErrors();
    };

    loginForm.onsubmit = (e) => { e.preventDefault(); handleLogin(e); };
    registerForm.onsubmit = (e) => { e.preventDefault(); handleRegister(e); };

    document.querySelectorAll('input[name="accountType"]').forEach(radio => {
        radio.addEventListener('change', () => {
            document.querySelectorAll('input[name="accountType"]').forEach(r => {
                r.closest('.account-type-card').querySelector('.account-type-body').style.borderColor = '';
            });
        });
    });
}

function loadUsers() {
    // Apaga os usuários antigos existentes uma vez conforme solicitado
    if (!localStorage.getItem('users_cleaned_v3')) {
        localStorage.removeItem('uber_finance_users');
        localStorage.removeItem('uber_finance_logged_user');
        localStorage.setItem('users_cleaned_v3', 'true');
    }
    const d = localStorage.getItem('uber_finance_users');
    usersList = d ? JSON.parse(d) : [];
}
function saveUsers() { localStorage.setItem('uber_finance_users', JSON.stringify(usersList)); }
function clearAuthErrors() {
    ['loginErrorMsg','regErrorMsg'].forEach(id => {
        const el = document.getElementById(id);
        if (el) { el.textContent = ''; el.classList.add('hidden'); }
    });
}
function showError(id, msg) {
    const el = document.getElementById(id);
    if (el) { el.textContent = msg; el.classList.remove('hidden'); }
}

// API & Cloud Database Sync (SUPABASE)
async function syncCloudLoad() {
    if (!supabaseClient || !currentUser) return;
    try {
        const { data: { user } } = await supabaseClient.auth.getUser();
        if (!user) return;

        if (currentUser.accountType === 'uber') {
            const [uRes, pRes, sRes] = await Promise.all([
                supabaseClient.from('uber_entries').select('*'),
                supabaseClient.from('personal_entries').select('*'),
                supabaseClient.from('user_settings').select('settings_json').single()
            ]);
            
            if (uRes.data && uRes.data.length) uberEntries = uRes.data.map(r => ({ id: r.id, date: r.date, gross: r.gross, fuel: r.fuel, other: r.other, otherDesc: r.other_desc, km: r.km }));
            if (pRes.data && pRes.data.length) personalEntries = pRes.data.map(r => ({ id: r.id, date: r.date, category: r.category, value: r.value, status: r.status, desc: r.description }));
            if (sRes.data && sRes.data.settings_json) uberSettings = { ...uberSettings, ...sRes.data.settings_json };
            
            localStorage.setItem(userKey('uber_finance_entries'), JSON.stringify(uberEntries));
            localStorage.setItem(userKey('uber_finance_personal_entries'), JSON.stringify(personalEntries));
            localStorage.setItem(userKey('uber_finance_settings'), JSON.stringify(uberSettings));
            
        } else if (currentUser.accountType === 'grafica') {
            const [prodsRes, vndsRes, despsOpRes, despsPessRes, sRes] = await Promise.all([
                supabaseClient.from('grafica_produtos').select('*'),
                supabaseClient.from('grafica_vendas').select('*'),
                supabaseClient.from('grafica_despesas_op').select('*'),
                supabaseClient.from('grafica_despesas_pessoais').select('*'),
                supabaseClient.from('user_settings').select('settings_json').single()
            ]);

            if (prodsRes.data && prodsRes.data.length) graficaProdutos = prodsRes.data.map(r => ({ id: r.id, tipo: r.tipo, nome: r.nome, categoria: r.categoria, medidas: r.medidas, tipoPapel: r.tipo_papel, acabamento: r.acabamento, custoUnitario: r.custo_unitario, margemLucro: r.margem_lucro, precoVenda: r.preco_venda, qtdEstoque: r.qtd_estoque, estoqueMinimo: r.estoque_minimo }));
            if (vndsRes.data && vndsRes.data.length) graficaVendas = vndsRes.data.map(r => ({ id: r.id, data: r.date, cliente: r.cliente, tipoItem: r.tipo_item, produtoId: r.produto_id, detalhes: r.detalhes, larguraCm: r.largura_cm, alturaCm: r.altura_cm, m2Total: r.m2_total, qtd: r.qtd, custoTotal: r.custo_total, precoTotal: r.preco_total, lucro: r.lucro, formaPagamento: r.forma_pagamento, obs: r.obs }));
            if (despsOpRes.data && despsOpRes.data.length) graficaDespesasOp = despsOpRes.data.map(r => ({ id: r.id, data: r.date, categoria: r.categoria, descricao: r.descricao, valor: r.valor, status: r.status }));
            if (despsPessRes.data && despsPessRes.data.length) graficaDespesasPessoais = despsPessRes.data.map(r => ({ id: r.id, vencimento: r.vencimento, pagamento: r.pagamento, categoria: r.categoria, valor: r.valor, status: r.status, descricao: r.descricao }));
            if (sRes.data && sRes.data.settings_json) graficaSettings = { ...graficaSettings, ...sRes.data.settings_json };

            localStorage.setItem(userKey('grafica_produtos'), JSON.stringify(graficaProdutos));
            localStorage.setItem(userKey('grafica_vendas'), JSON.stringify(graficaVendas));
            localStorage.setItem(userKey('grafica_despesas_op'), JSON.stringify(graficaDespesasOp));
            localStorage.setItem(userKey('grafica_despesas_pessoais'), JSON.stringify(graficaDespesasPessoais));
            localStorage.setItem(userKey('grafica_settings'), JSON.stringify(graficaSettings));
        }
    } catch(err) {
        console.warn('Erro ao ler do Supabase, rodando em modo local:', err);
    }
}

let lastSyncTimeStr = 'Salvo';
function updateSyncTimeUI() {
    const uBtn = document.getElementById('uberSyncTime');
    const rBtn = document.getElementById('roupasSyncTime');
    const gBtn = document.getElementById('graficaSyncTime');
    if (uBtn) uBtn.textContent = lastSyncTimeStr;
    if (rBtn) rBtn.textContent = lastSyncTimeStr;
    if (gBtn) gBtn.textContent = lastSyncTimeStr;
}

window.manualCloudSync = async function(btnId, timeId) {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    const oldHtml = btn.innerHTML;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Sincronizando...';
    await syncCloudSave();
    btn.innerHTML = `<i class="fa-solid fa-cloud-check"></i> <span id="${timeId}">${lastSyncTimeStr}</span>`;
    showToast('Sincronizado com a nuvem!', 'success');
};

async function deleteCloudItem(table, id) {
    if (!supabaseClient || !currentUser) return;
    try {
        await supabaseClient.from(table).delete().eq('id', id);
    } catch(err) {
        console.warn('Erro ao deletar da nuvem:', err);
    }
}

async function syncCloudSave() {
    if (!supabaseClient || !currentUser) return;
    try {
        const { data: { user } } = await supabaseClient.auth.getUser();
        if (!user) return;
        const uid = user.id;

        const checkErr = (res, context) => {
            if (res.error) throw new Error(`Erro em ${context}: ${res.error.message || JSON.stringify(res.error)}`);
        };

        if (currentUser.accountType === 'uber') {
            if (uberEntries.length) checkErr(await supabaseClient.from('uber_entries').upsert(uberEntries.map(e => ({ id: e.id, user_id: uid, date: e.date, gross: e.gross, fuel: e.fuel, other: e.other, other_desc: e.otherDesc, km: e.km }))), 'Uber Entries');
            if (personalEntries.length) checkErr(await supabaseClient.from('personal_entries').upsert(personalEntries.map(e => ({ id: e.id, user_id: uid, date: e.date, category: e.category, value: e.value, status: e.status, description: e.desc }))), 'Personal Entries');
            checkErr(await supabaseClient.from('user_settings').upsert({ user_id: uid, settings_json: uberSettings }), 'Uber Settings');
        } else if (currentUser.accountType === 'roupas') {
            if (estoqueItems.length) checkErr(await supabaseClient.from('estoque_items').upsert(estoqueItems.map(e => ({ id: e.id, user_id: uid, nome: e.nome, categoria: e.categoria, tamanho: e.tamanho, qtd: e.qtd, custo: e.custo, preco_venda: e.precoVenda, data_entrada: e.dataEntrada }))), 'Estoque');
            if (comprasEntries.length) checkErr(await supabaseClient.from('compras_entries').upsert(comprasEntries.map(e => ({ id: e.id, user_id: uid, date: e.data, produto: e.produto, qtd: e.qtd, custo: e.custo, transporte: e.transporte, fornecedor: e.fornecedor }))), 'Compras');
            if (vendasEntries.length) checkErr(await supabaseClient.from('vendas_entries').upsert(vendasEntries.map(e => ({ id: e.id, user_id: uid, date: e.data, stock_item_id: e.stockItemId, produto: e.produto, tamanho: e.tamanho, qtd: e.qtd, valor: e.valor, custo_ref: e.custoRef, lucro: e.lucro, obs: e.obs }))), 'Vendas');
            checkErr(await supabaseClient.from('user_settings').upsert({ user_id: uid, settings_json: roupasSettings }), 'Roupas Settings');
        } else if (currentUser.accountType === 'grafica') {
            if (graficaProdutos.length) checkErr(await supabaseClient.from('grafica_produtos').upsert(graficaProdutos.map(e => ({ id: e.id, user_id: uid, tipo: e.tipo, nome: e.nome, categoria: e.categoria, medidas: e.medidas, tipo_papel: e.tipoPapel, acabamento: e.acabamento, custo_unitario: e.custoUnitario, margem_lucro: e.margemLucro, preco_venda: e.precoVenda, qtd_estoque: e.qtdEstoque, estoque_minimo: e.estoqueMinimo }))), 'Gráfica Produtos');
            if (graficaVendas.length) checkErr(await supabaseClient.from('grafica_vendas').upsert(graficaVendas.map(e => ({ id: e.id, user_id: uid, date: e.data, cliente: e.cliente, tipo_item: e.tipoItem, produto_id: e.produtoId, detalhes: e.detalhes, largura_cm: e.larguraCm, altura_cm: e.alturaCm, m2_total: e.m2Total, qtd: e.qtd, custo_total: e.custoTotal, preco_total: e.precoTotal, lucro: e.lucro, forma_pagamento: e.formaPagamento, obs: e.obs }))), 'Gráfica Vendas');
            if (graficaDespesasOp.length) checkErr(await supabaseClient.from('grafica_despesas_op').upsert(graficaDespesasOp.map(e => ({ id: e.id, user_id: uid, date: e.data, categoria: e.categoria, descricao: e.descricao, valor: e.valor, status: e.status }))), 'Gráfica Despesas Op');
            if (graficaDespesasPessoais.length) checkErr(await supabaseClient.from('grafica_despesas_pessoais').upsert(graficaDespesasPessoais.map(e => ({ id: e.id, user_id: uid, vencimento: e.vencimento, pagamento: e.pagamento, categoria: e.categoria, valor: e.valor, status: e.status, descricao: e.descricao }))), 'Gráfica Despesas Pessoais');
            checkErr(await supabaseClient.from('user_settings').upsert({ user_id: uid, settings_json: graficaSettings }), 'Gráfica Settings');
        }
        
        lastSyncTimeStr = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        updateSyncTimeUI();
    } catch(err) {
        console.warn('Falha ao salvar no banco de dados da hospedagem:', err);
        alert('Erro ao sincronizar na nuvem:\n\n' + err.message);
    }
}

async function handleRegister(e) {
    e.preventDefault();
    clearAuthErrors();

    const name = document.getElementById('regName').value.trim();
    const username = document.getElementById('regUsername').value.trim().toLowerCase();
    const password = document.getElementById('regPassword').value;
    const confirm = document.getElementById('regConfirmPassword').value;
    const typeRadio = document.querySelector('input[name="accountType"]:checked');

    if (!name || !username || !password) return showError('regErrorMsg', 'Preencha todos os campos.');
    if (!typeRadio) return showError('regErrorMsg', 'Selecione o tipo de conta: Uber ou Roupas.');
    if (password !== confirm) return showError('regErrorMsg', 'As senhas não coincidem.');

    if (supabaseClient) {
        try {
            const fakeEmail = `${username}@meuapp.local`;
            const { data, error } = await supabaseClient.auth.signUp({
                email: fakeEmail,
                password: password,
                options: {
                    data: { name: name, username: username, account_type: typeRadio.value }
                }
            });
            if (error) return showError('regErrorMsg', error.message);
            
            // Supabase auth auto-logs in. Also, RLS allows this insert.
            if (data.user) {
                await supabaseClient.from('profiles').insert([{
                    id: data.user.id,
                    name: name,
                    username: username,
                    account_type: typeRadio.value
                }]);
            }

            authToken = data.session ? data.session.access_token : 'supabase-active';
            localStorage.setItem('uber_finance_auth_token', authToken);
            currentUser = { name, username, accountType: typeRadio.value };
            localStorage.setItem('uber_finance_logged_user', JSON.stringify(currentUser));
            document.getElementById('registerForm').reset();
            await startSession();
            return;
        } catch(err) {
            showError('regErrorMsg', 'Erro de conexão com o Supabase.');
            return;
        }
    }

    // Fallback local se Supabase não configurado
    const user = { name, username, password, accountType: typeRadio.value };
    usersList.push(user);
    saveUsers();
    currentUser = { name, username, accountType: typeRadio.value };
    localStorage.setItem('uber_finance_logged_user', JSON.stringify(currentUser));
    document.getElementById('registerForm').reset();
    await startSession();
}

async function handleLogin(e) {
    e.preventDefault();
    clearAuthErrors();

    const username = document.getElementById('loginUsername').value.trim().toLowerCase();
    const password = document.getElementById('loginPassword').value;

    let loginSuccess = false;
    let localFound = usersList.find(u => u.username === username && u.password === password);

    if (supabaseClient) {
        try {
            const fakeEmail = `${username}@meuapp.local`;
            const { data, error } = await supabaseClient.auth.signInWithPassword({
                email: fakeEmail,
                password: password
            });
            
            if (error) {
                return showError('loginErrorMsg', error.message === 'Email not confirmed' 
                    ? 'Erro: Confirmação de E-mail está ativada no Supabase. Desative-a nas configurações de Auth.' 
                    : (error.message || 'Usuário ou senha incorretos.'));
            }

            if (data && data.user) {
                // Sucesso no Supabase!
                const { data: profile } = await supabaseClient.from('profiles').select('*').eq('id', data.user.id).single();
                
                authToken = data.session ? data.session.access_token : 'supabase-active';
                localStorage.setItem('uber_finance_auth_token', authToken);
                currentUser = profile 
                    ? { name: profile.name, username: profile.username, accountType: profile.account_type }
                    : (localFound ? { name: localFound.name, username: localFound.username, accountType: localFound.accountType } : { name: username, username, accountType: 'uber' });
                
                localStorage.setItem('uber_finance_logged_user', JSON.stringify(currentUser));
                document.getElementById('loginForm').reset();
                await startSession();
                return;
            } else if (localFound) {
                // Se falhou no Supabase mas a conta existe localmente (conta antiga), vamos migrar!
                const { data: regData, error: regError } = await supabaseClient.auth.signUp({
                    email: fakeEmail,
                    password: password,
                    options: { data: { name: localFound.name, username: localFound.username, account_type: localFound.accountType } }
                });
                
                if (regData && regData.user) {
                    await supabaseClient.from('profiles').insert([{
                        id: regData.user.id,
                        name: localFound.name,
                        username: localFound.username,
                        account_type: localFound.accountType
                    }]);
                    authToken = regData.session ? regData.session.access_token : 'supabase-active';
                    localStorage.setItem('uber_finance_auth_token', authToken);
                }
            }
        } catch(err) {
            console.error('Erro de Supabase Auth:', err);
        }
    }

    // Se chegou aqui, ou o Supabase falhou e migramos a conta, ou o Supabase tá offline. Tenta logar local.
    if (localFound) {
        currentUser = { name: localFound.name, username: localFound.username, accountType: localFound.accountType };
        localStorage.setItem('uber_finance_logged_user', JSON.stringify(currentUser));
        document.getElementById('loginForm').reset();
        await startSession();
        return;
    }

    // Se não encontrou nem no Supabase nem local
    showError('loginErrorMsg', 'Usuário ou senha incorretos.');
}

function handleLogout() {
    if (!confirm('Deseja sair do sistema?')) return;
    if (supabaseClient) supabaseClient.auth.signOut();
    localStorage.removeItem('uber_finance_logged_user');
    localStorage.removeItem('uber_finance_auth_token');
    currentUser = null;
    authToken = null;
    Object.values(charts).forEach(c => { try { c.destroy(); } catch(e) {} });
    charts = {};
    showAuth();
}

function showAuth() {
    document.getElementById('authOverlay').classList.remove('hidden');
    document.getElementById('uberApp').classList.add('hidden');
    document.getElementById('roupasApp').classList.add('hidden');
    document.getElementById('graficaApp').classList.add('hidden');
}

function hideAuth() {
    document.getElementById('authOverlay').classList.add('hidden');
}

// =====================================================
// SESSION START — ROUTING
// =====================================================
function startSession() {
    if (!currentUser || !currentUser.accountType) {
        localStorage.removeItem('uber_finance_logged_user');
        currentUser = null;
        showAuth();
        return;
    }

    hideAuth();

    try {
        if (currentUser.accountType === 'uber') {
            startUberSession();
        } else if (currentUser.accountType === 'roupas') {
            startRoupasSession();
        } else if (currentUser.accountType === 'grafica') {
            startGraficaSession();
        } else {
            localStorage.removeItem('uber_finance_logged_user');
            currentUser = null;
            showAuth();
        }
    } catch(err) {
        console.error('Erro ao iniciar sessão:', err);
        localStorage.removeItem('uber_finance_logged_user');
        currentUser = null;
        showAuth();
    }
}

// =====================================================
// =====================================================
//  UBER MODULE
// =====================================================
// =====================================================
async function startUberSession() {
    document.getElementById('uberApp').classList.remove('hidden');
    document.getElementById('uberHeaderUserName').textContent = currentUser.name;

    document.getElementById('uberLogoutBtn').onclick = handleLogout;
    document.getElementById('uberSyncBtn').onclick = () => window.manualCloudSync('uberSyncBtn', 'uberSyncTime');

    loadUberSettings();
    loadUberEntries();
    loadPersonalEntries();

    // Sincronizar com banco de dados na nuvem/hospedagem
    await syncCloudLoad();

    document.getElementById('entryDate').value = todayISO();
    document.getElementById('personalDate').value = todayISO();

    updateCurrencySymbols();
    populateUberMonthFilter();
    setupUberTabs();
    setupUberListeners();
    renderUberApp();

    // Daily backup check
    checkAndRunDailyBackup();
}

// ----- Storage -----
function loadUberSettings() {
    const d = localStorage.getItem(userKey('uber_finance_settings'));
    uberSettings = d ? JSON.parse(d) : {
        currency: 'PYG',
        monthlyExpenseLimit: 0,
        backupEmail: '',
        emailjsServiceId: '',
        emailjsTemplateId: '',
        emailjsPublicKey: ''
    };
}
function saveUberSettings() { 
    localStorage.setItem(userKey('uber_finance_settings'), JSON.stringify(uberSettings)); 
    syncCloudSave();
}

function loadUberEntries() {
    const d = localStorage.getItem(userKey('uber_finance_entries'));
    uberEntries = d ? JSON.parse(d) : [];
}
function saveUberEntries() { 
    localStorage.setItem(userKey('uber_finance_entries'), JSON.stringify(uberEntries)); 
    syncCloudSave();
}

function loadPersonalEntries() {
    const d = localStorage.getItem(userKey('uber_finance_personal_entries'));
    personalEntries = d ? JSON.parse(d) : [];
}
function savePersonalEntries() { 
    localStorage.setItem(userKey('uber_finance_personal_entries'), JSON.stringify(personalEntries)); 
    syncCloudSave();
}

// ----- Tabs -----
function setupUberTabs() {
    document.querySelectorAll('#uberTabsNav .tab-btn').forEach(btn => {
        btn.onclick = () => {
            document.querySelectorAll('#uberTabsNav .tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('#uberApp .tab-content').forEach(c => c.classList.remove('active'));
            btn.classList.add('active');
            document.getElementById(btn.dataset.tab).classList.add('active');
            renderUberApp();
        };
    });
}

// ----- Month Filter -----
function populateUberMonthFilter() {
    const select = document.getElementById('monthFilter');
    const prev = select.value;
    const months = new Set([new Date().toISOString().substring(0, 7)]);
    uberEntries.forEach(e => months.add(monthKey(e.date)));
    personalEntries.forEach(e => months.add(monthKey(e.date)));
    const sorted = Array.from(months).sort().reverse();
    select.innerHTML = sorted.map(m => {
        const [yr, mo] = m.split('-');
        const lbl = new Date(+yr, +mo - 1, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
        return `<option value="${m}">${lbl.charAt(0).toUpperCase() + lbl.slice(1)}</option>`;
    }).join('');
    if (prev && sorted.includes(prev)) select.value = prev;
}

// ----- Listeners -----
function setupUberListeners() {
    document.getElementById('monthFilter').onchange = renderUberApp;

    document.getElementById('entryForm').onsubmit = handleUberSubmit;
    document.getElementById('cancelEditBtn').onclick = resetUberForm;
    document.getElementById('loadSampleDataBtn').onclick = () => {
        if (confirm('Carregar dados de exemplo Uber?')) { generateUberSample(); populateUberMonthFilter(); renderUberApp(); }
    };
    document.getElementById('clearAllBtn').onclick = () => {
        const m = document.getElementById('monthFilter').value;
        if (confirm(`Apagar lançamentos Uber de ${m}?`)) {
            const toDel = uberEntries.filter(e => monthKey(e.date) === m);
            toDel.forEach(e => deleteCloudItem('uber_entries', e.id));
            uberEntries = uberEntries.filter(e => monthKey(e.date) !== m);
            saveUberEntries(); populateUberMonthFilter(); renderUberApp();
        }
    };

    document.getElementById('personalForm').onsubmit = handlePersonalSubmit;
    document.getElementById('cancelPersonalEditBtn').onclick = resetPersonalForm;
    document.getElementById('loadPersonalSampleBtn').onclick = () => {
        if (confirm('Carregar dados de exemplo Casa?')) { generatePersonalSample(); populateUberMonthFilter(); renderUberApp(); }
    };
    document.getElementById('clearPersonalMonthBtn').onclick = () => {
        const m = document.getElementById('monthFilter').value;
        if (confirm(`Apagar despesas casa de ${m}?`)) {
            const toDel = personalEntries.filter(e => monthKey(e.date) === m);
            toDel.forEach(e => deleteCloudItem('personal_entries', e.id));
            personalEntries = personalEntries.filter(e => monthKey(e.date) !== m);
            savePersonalEntries(); populateUberMonthFilter(); renderUberApp();
        }
    };

    document.getElementById('exportCsvBtn').onclick = exportUberCSV;

    // Uber Settings & Backup listeners
    document.getElementById('openSettingsBtn').onclick = () => {
        document.getElementById('currencySelect').value = uberSettings.currency || 'PYG';
        document.getElementById('monthlyLimitInput').value = uberSettings.monthlyExpenseLimit || '';
        document.getElementById('backupEmail').value = uberSettings.backupEmail || '';
        document.getElementById('emailjsServiceId').value = uberSettings.emailjsServiceId || '';
        document.getElementById('emailjsTemplateId').value = uberSettings.emailjsTemplateId || '';
        document.getElementById('emailjsPublicKey').value = uberSettings.emailjsPublicKey || '';
        document.getElementById('settingsModal').classList.remove('hidden');
    };
    document.getElementById('closeSettingsBtn').onclick = () => document.getElementById('settingsModal').classList.add('hidden');
    document.getElementById('cancelSettingsBtn').onclick = () => document.getElementById('settingsModal').classList.add('hidden');
    document.getElementById('settingsForm').onsubmit = e => {
        e.preventDefault();
        uberSettings.currency = document.getElementById('currencySelect').value;
        uberSettings.monthlyExpenseLimit = parseFloat(document.getElementById('monthlyLimitInput').value) || 0;
        uberSettings.backupEmail = document.getElementById('backupEmail').value.trim();
        uberSettings.emailjsServiceId = document.getElementById('emailjsServiceId').value.trim();
        uberSettings.emailjsTemplateId = document.getElementById('emailjsTemplateId').value.trim();
        uberSettings.emailjsPublicKey = document.getElementById('emailjsPublicKey').value.trim();
        saveUberSettings();
        updateCurrencySymbols();
        renderUberApp();
        document.getElementById('settingsModal').classList.add('hidden');
        showToast('Configurações salvas com sucesso!', 'success');
    };

    document.getElementById('manualBackupBtn').onclick = () => {
        downloadJSONBackup();
        showToast('Backup JSON baixado com sucesso!', 'success');
    };
    document.getElementById('testEmailBtn').onclick = () => sendEmailBackup(true);
}

// ----- Main Render -----
function renderUberApp() {
    const m = document.getElementById('monthFilter').value;
    const uber = uberEntries.filter(e => monthKey(e.date) === m).sort((a,b) => new Date(a.date)-new Date(b.date));
    const personal = personalEntries.filter(e => monthKey(e.date) === m).sort((a,b) => new Date(a.date)-new Date(b.date));

    const pTotals = renderPersonalTab(personal);
    const goal = uberSettings.monthlyExpenseLimit > 0 ? uberSettings.monthlyExpenseLimit : pTotals.total;
    const uTotals = renderUberTab(uber, goal, m);
    renderUberSummary(uTotals.net, pTotals.total);
}

// ----- Uber Tab -----
function renderUberTab(data, goal, m) {
    let gross=0, fuel=0, other=0;
    data.forEach(e => { gross += +e.gross||0; fuel += +e.fuel||0; other += +e.other||0; });
    const expenses = fuel + other;
    const net = gross - expenses;
    const days = data.length;
    const avgNet = days ? net/days : 0;
    const fuelPct = gross ? (fuel/gross*100) : 0;

    document.getElementById('kpiGrossEarnings').textContent = fmt(gross);
    document.getElementById('kpiGrossDays').textContent = `${days} ${days===1?'dia':'dias'} trabalhados`;
    document.getElementById('kpiFuelExpenses').textContent = fmt(fuel);
    document.getElementById('kpiFuelPercent').textContent = `${fuelPct.toFixed(1)}% do faturamento`;
    document.getElementById('kpiOtherExpenses').textContent = fmt(other);
    document.getElementById('kpiTotalExpenses').textContent = fmt(expenses);
    document.getElementById('kpiNetProfit').textContent = fmt(net);
    document.getElementById('kpiDailyAvgNet').textContent = `Média Real: ${fmt(avgNet)} / dia`;

    renderUberGoal(net, goal, m);

    const tbody = document.getElementById('tableBody');
    tbody.innerHTML = data.length === 0 ? emptyRow(8) : data.map(item => {
        const g=+item.gross||0, f=+item.fuel||0, o=+item.other||0;
        const exp=f+o, n=g-exp;
        return `<tr>
            <td><strong>${dateBR(item.date)}</strong></td>
            <td class="text-success">${fmt(g)}</td>
            <td class="text-danger">${fmt(f)}</td>
            <td>${fmt(o)}</td>
            <td class="text-danger"><strong>${fmt(exp)}</strong></td>
            <td class="text-success"><strong>${fmt(n)}</strong></td>
            <td>${item.otherDesc||'-'}${item.km?`<br><small class="text-muted">${item.km} km</small>`:''}</td>
            <td class="text-center"><div class="action-btns">
                <button class="action-btn action-edit" onclick="editUber('${item.id}')"><i class="fa-solid fa-pen"></i></button>
                <button class="action-btn action-delete" onclick="deleteUber('${item.id}')"><i class="fa-solid fa-trash"></i></button>
            </div></td>
        </tr>`;
    }).join('');

    document.getElementById('footGross').textContent = fmt(gross);
    document.getElementById('footFuel').textContent = fmt(fuel);
    document.getElementById('footOther').textContent = fmt(other);
    document.getElementById('footTotalExpenses').innerHTML = `<strong>${fmt(expenses)}</strong>`;
    document.getElementById('footNet').innerHTML = `<strong>${fmt(net)}</strong>`;

    renderUberChart(data);
    return { gross, fuel, other, expenses, net };
}

function renderUberGoal(net, goal, m) {
    const [yr, mo] = (m || todayISO().substring(0,7)).split('-');
    const daysInMonth = new Date(+yr, +mo, 0).getDate() || 30;
    const el_limit = document.getElementById('kpiBudgetLimit');
    const el_prog = document.getElementById('kpiBudgetProgress');
    const el_status = document.getElementById('kpiBudgetStatus');
    const el_daily = document.getElementById('kpiDailyTargetNeeded');

    if (!goal || goal <= 0) {
        el_limit.textContent = fmt(0);
        el_prog.style.width = '0%';
        el_status.innerHTML = '<span class="text-muted">Cadastre despesas da casa para calcular</span>';
        el_daily.innerHTML = `<i class="fa-solid fa-lightbulb"></i> Meta Diária Informativa: <strong>${fmt(0)} / dia</strong>`;
        return;
    }

    el_limit.textContent = fmt(goal);
    const pct = Math.min(Math.max((net/goal)*100, 0), 100);
    el_prog.style.width = `${pct}%`;
    el_daily.innerHTML = `<i class="fa-solid fa-lightbulb"></i> Meta Diária Informativa: <strong>${fmt(goal/daysInMonth)} / dia</strong> (${daysInMonth} dias)`;

    if (net >= goal) {
        el_prog.classList.add('exceeded');
        el_status.innerHTML = `<span class="text-success"><i class="fa-solid fa-circle-check"></i> <strong>Contas 100% cobertas!</strong> (Sobra: ${fmt(net-goal)})</span>`;
    } else {
        el_prog.classList.remove('exceeded');
        const pctTxt = ((net/goal)*100).toFixed(0);
        el_status.innerHTML = `<span class="text-danger"><i class="fa-solid fa-clock"></i> <strong>Falta ${fmt(goal-net)}</strong> (${pctTxt}% coberto)</span>`;
    }
}

// ----- Personal Tab -----
function renderPersonalTab(data) {
    let total=0, paid=0, paidCnt=0, pending=0, pendingCnt=0, market=0, car=0;
    data.forEach(e => {
        const v = +e.value||0;
        total += v;
        if (e.status === 'Pago') { paid+=v; paidCnt++; } else { pending+=v; pendingCnt++; }
        if (e.category === 'Mercado') market += v;
        if (e.category === 'Carro') car += v;
    });

    document.getElementById('kpiPersonalTotal').textContent = fmt(total);
    document.getElementById('kpiPersonalCount').textContent = `${data.length} despesas`;
    document.getElementById('kpiPersonalPaid').textContent = fmt(paid);
    document.getElementById('kpiPersonalPaidCount').textContent = `${paidCnt} pagas`;
    document.getElementById('kpiPersonalPending').textContent = fmt(pending);
    document.getElementById('kpiPersonalPendingCount').textContent = `${pendingCnt} a pagar`;
    document.getElementById('kpiPersonalMarket').textContent = fmt(market);
    document.getElementById('kpiPersonalCar').textContent = fmt(car);

    const tbody = document.getElementById('personalTableBody');
    tbody.innerHTML = data.length === 0 ? emptyRow(6) : data.map(item => {
        const v = +item.value||0;
        const sc = item.status==='Pago' ? 'status-paid' : 'status-pending';
        return `<tr>
            <td><strong>${dateBR(item.date)}</strong></td>
            <td><span class="badge-category">${item.category}</span></td>
            <td>${item.desc||'-'}</td>
            <td class="text-danger"><strong>${fmt(v)}</strong></td>
            <td><span class="status-badge ${sc}">${item.status==='Pago'?'✅ Pago':'⏳ Pendente'}</span></td>
            <td class="text-center"><div class="action-btns">
                <button class="action-btn action-edit" onclick="editPersonal('${item.id}')"><i class="fa-solid fa-pen"></i></button>
                <button class="action-btn action-delete" onclick="deletePersonal('${item.id}')"><i class="fa-solid fa-trash"></i></button>
            </div></td>
        </tr>`;
    }).join('');

    document.getElementById('footPersonalTotal').innerHTML = `<strong>${fmt(total)}</strong>`;
    renderPersonalChart(data);
    return { total, paid, pending };
}

// ----- Summary Tab -----
function renderUberSummary(uberNet, personalTotal) {
    const balance = uberNet - personalTotal;
    document.getElementById('sumUberNet').textContent = fmt(uberNet);
    document.getElementById('sumPersonalTotal').textContent = fmt(personalTotal);
    document.getElementById('sumFinalBalance').textContent = fmt(balance);
    const el = document.getElementById('sumFinalBalance');
    const sub = document.getElementById('sumFinalSubtext');
    if (balance >= 0) { el.className = 'text-success'; sub.textContent = 'Sobrou no bolso após todas as contas!'; }
    else { el.className = 'text-danger'; sub.textContent = 'Atenção: Despesas superaram o lucro Uber!'; }
    renderConsolidatedChart(uberNet, personalTotal, balance);
}

// ----- Uber CRUD -----
function handleUberSubmit(e) {
    e.preventDefault();
    const id = document.getElementById('entryId').value || Date.now().toString();
    const date = document.getElementById('entryDate').value;
    if (!date) return alert('Informe a data.');
    const entry = {
        id, date,
        gross: parseFloat(document.getElementById('entryGross').value)||0,
        fuel: parseFloat(document.getElementById('entryFuel').value)||0,
        other: parseFloat(document.getElementById('entryOther').value)||0,
        otherDesc: document.getElementById('entryOtherDesc').value.trim(),
        km: document.getElementById('entryKm').value ? parseFloat(document.getElementById('entryKm').value) : null
    };
    if (editingUberId) {
        const i = uberEntries.findIndex(e => e.id === editingUberId);
        if (i !== -1) uberEntries[i] = entry;
    } else {
        uberEntries.push(entry);
    }
    saveUberEntries();
    document.getElementById('monthFilter').value = monthKey(date);
    populateUberMonthFilter();
    document.getElementById('monthFilter').value = monthKey(date);
    resetUberForm();
    renderUberApp();
}

window.editUber = function(id) {
    const item = uberEntries.find(e => e.id === id);
    if (!item) return;
    editingUberId = id;
    document.getElementById('entryId').value = item.id;
    document.getElementById('entryDate').value = item.date;
    document.getElementById('entryGross').value = item.gross;
    document.getElementById('entryFuel').value = item.fuel;
    document.getElementById('entryOther').value = item.other||'';
    document.getElementById('entryOtherDesc').value = item.otherDesc||'';
    document.getElementById('entryKm').value = item.km||'';
    document.getElementById('formTitle').textContent = 'Editar Lançamento';
    document.getElementById('saveBtn').innerHTML = '<i class="fa-solid fa-check"></i> Atualizar';
    document.getElementById('cancelEditBtn').classList.remove('hidden');
    document.getElementById('entryForm').scrollIntoView({ behavior: 'smooth', block: 'center' });
};

window.deleteUber = function(id) {
    if (!confirm('Excluir lançamento?')) return;
    uberEntries = uberEntries.filter(e => e.id !== id);
    deleteCloudItem('uber_entries', id);
    saveUberEntries(); populateUberMonthFilter(); renderUberApp();
};

function resetUberForm() {
    document.getElementById('entryForm').reset();
    document.getElementById('entryId').value = '';
    document.getElementById('entryDate').value = todayISO();
    editingUberId = null;
    document.getElementById('formTitle').textContent = 'Novo Lançamento Diário';
    document.getElementById('saveBtn').innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Salvar Lançamento';
    document.getElementById('cancelEditBtn').classList.add('hidden');
}

// ----- Personal CRUD -----
function handlePersonalSubmit(e) {
    e.preventDefault();
    const id = document.getElementById('personalId').value || Date.now().toString();
    const date = document.getElementById('personalDate').value;
    if (!date) return alert('Informe a data.');
    const entry = {
        id, date,
        category: document.getElementById('personalCategory').value,
        value: parseFloat(document.getElementById('personalValue').value)||0,
        status: document.getElementById('personalStatus').value,
        desc: document.getElementById('personalDesc').value.trim()
    };
    if (editingPersonalId) {
        const i = personalEntries.findIndex(e => e.id === editingPersonalId);
        if (i !== -1) personalEntries[i] = entry;
    } else {
        personalEntries.push(entry);
    }
    savePersonalEntries();
    document.getElementById('monthFilter').value = monthKey(date);
    populateUberMonthFilter();
    document.getElementById('monthFilter').value = monthKey(date);
    resetPersonalForm();
    renderUberApp();
}

window.editPersonal = function(id) {
    const item = personalEntries.find(e => e.id === id);
    if (!item) return;
    editingPersonalId = id;
    document.getElementById('personalId').value = item.id;
    document.getElementById('personalDate').value = item.date;
    document.getElementById('personalCategory').value = item.category;
    document.getElementById('personalValue').value = item.value;
    document.getElementById('personalStatus').value = item.status;
    document.getElementById('personalDesc').value = item.desc||'';
    document.getElementById('personalFormTitle').textContent = 'Editar Despesa';
    document.getElementById('savePersonalBtn').innerHTML = '<i class="fa-solid fa-check"></i> Atualizar';
    document.getElementById('cancelPersonalEditBtn').classList.remove('hidden');
    document.getElementById('personalForm').scrollIntoView({ behavior: 'smooth', block: 'center' });
};

window.deletePersonal = function(id) {
    if (!confirm('Excluir despesa?')) return;
    personalEntries = personalEntries.filter(e => e.id !== id);
    deleteCloudItem('personal_entries', id);
    savePersonalEntries(); populateUberMonthFilter(); renderUberApp();
};

function resetPersonalForm() {
    document.getElementById('personalForm').reset();
    document.getElementById('personalId').value = '';
    document.getElementById('personalDate').value = todayISO();
    editingPersonalId = null;
    document.getElementById('personalFormTitle').textContent = 'Nova Despesa da Casa';
    document.getElementById('savePersonalBtn').innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Salvar Despesa';
    document.getElementById('cancelPersonalEditBtn').classList.add('hidden');
}

// ----- Sample Data -----
function generateUberSample() {
    const [yr, mo] = new Date().toISOString().substring(0,7).split('-');
    const m = parseInt(uberSettings.currency === 'PYG' ? 6000 : 1);
    [
        { id:'us1', date:`${yr}-${mo}-01`, gross:350*m, fuel:85*m, other:15*m, otherDesc:'Lanche', km:195 },
        { id:'us2', date:`${yr}-${mo}-02`, gross:420*m, fuel:90*m, other:0, otherDesc:'', km:210 },
        { id:'us3', date:`${yr}-${mo}-03`, gross:380*m, fuel:88*m, other:30*m, otherDesc:'Lava-rápido', km:200 },
    ].forEach(s => uberEntries.push(s));
    saveUberEntries();
}

function generatePersonalSample() {
    const [yr, mo] = new Date().toISOString().substring(0,7).split('-');
    const m = parseInt(uberSettings.currency === 'PYG' ? 1 : 1);
    [
        { id:'ps1', date:`${yr}-${mo}-05`, category:'Carro', value:800000*m, status:'Pago', desc:'Parcela do carro' },
        { id:'ps2', date:`${yr}-${mo}-08`, category:'Aluguel', value:700000*m, status:'Pago', desc:'Aluguel casa' },
        { id:'ps3', date:`${yr}-${mo}-10`, category:'Mercado', value:450000*m, status:'Pendente', desc:'Compras mês' },
    ].forEach(s => personalEntries.push(s));
    savePersonalEntries();
}

// ----- Uber Charts -----
function renderUberChart(data) {
    const ctx = document.getElementById('performanceChart');
    if (!ctx) return;
    if (charts.uber) { charts.uber.destroy(); }
    const cfg = CURRENCY_CONFIG[uberSettings.currency] || CURRENCY_CONFIG.PYG;
    charts.uber = new Chart(ctx.getContext('2d'), {
        type: 'bar',
        data: {
            labels: data.map(e => dateBR(e.date)),
            datasets: [
                { label: `Faturamento`, data: data.map(e => +e.gross||0), backgroundColor: 'rgba(59,130,246,.7)' },
                { label: `Gastos Uber`, data: data.map(e => (+e.fuel||0)+(+e.other||0)), backgroundColor: 'rgba(239,68,68,.7)' },
                { label: `Lucro`, data: data.map(e => (+e.gross||0)-(+e.fuel||0)-(+e.other||0)), type: 'line', borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,.1)', tension: .3 },
            ]
        },
        options: chartOpts(cfg.symbol)
    });
}

function renderPersonalChart(data) {
    const ctx = document.getElementById('personalChart');
    if (!ctx) return;
    if (charts.personal) charts.personal.destroy();
    const cats = {};
    data.forEach(e => { cats[e.category] = (cats[e.category]||0) + (+e.value||0); });
    charts.personal = new Chart(ctx.getContext('2d'), {
        type: 'doughnut',
        data: {
            labels: Object.keys(cats),
            datasets: [{ data: Object.values(cats), backgroundColor: ['#ef4444','#3b82f6','#10b981','#f59e0b','#8b5cf6','#06b6d4','#ec4899'] }]
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right', labels: { color: '#94a3b8' } } } }
    });
}

function renderConsolidatedChart(uberNet, personalTotal, balance) {
    const ctx = document.getElementById('consolidatedChart');
    if (!ctx) return;
    if (charts.consolidated) charts.consolidated.destroy();
    const cfg = CURRENCY_CONFIG[uberSettings.currency] || CURRENCY_CONFIG.PYG;
    charts.consolidated = new Chart(ctx.getContext('2d'), {
        type: 'bar',
        data: {
            labels: ['Lucro Uber', 'Despesas Casa', 'Saldo Final'],
            datasets: [{ label: `Valor (${cfg.symbol})`, data: [uberNet, personalTotal, balance], backgroundColor: ['rgba(16,185,129,.7)','rgba(239,68,68,.7)','rgba(59,130,246,.8)'], borderRadius: 8 }]
        },
        options: { ...chartOpts(cfg.symbol), plugins: { legend: { display: false } } }
    });
}

// ----- Uber CSV -----
function exportUberCSV() {
    const m = document.getElementById('monthFilter').value;
    const cfg = CURRENCY_CONFIG[uberSettings.currency] || CURRENCY_CONFIG.PYG;
    const uData = uberEntries.filter(e => monthKey(e.date) === m);
    const pData = personalEntries.filter(e => monthKey(e.date) === m);
    let csv = '\uFEFF';
    csv += `=== UBER (${m}) ===\n`;
    csv += `Data;Faturamento;Gasolina;Outros;Total Gastos;Lucro;KM;Obs\n`;
    let ug=0, uf=0, uo=0;
    uData.forEach(e => {
        const g=+e.gross||0, f=+e.fuel||0, o=+e.other||0;
        ug+=g; uf+=f; uo+=o;
        csv += `${dateBR(e.date)};${g};${f};${o};${f+o};${g-f-o};${e.km||''};"${e.otherDesc||''}"\n`;
    });
    csv += `TOTAL;${ug};${uf};${uo};${uf+uo};${ug-uf-uo};;\n\n`;
    csv += `=== CASA (${m}) ===\n`;
    csv += `Data;Categoria;Descrição;Valor;Status\n`;
    let pt=0;
    pData.forEach(e => { const v=+e.value||0; pt+=v; csv += `${dateBR(e.date)};${e.category};"${e.desc||''}";${v};${e.status}\n`; });
    csv += `TOTAL;;;${pt};\n\n`;
    const unet = ug-uf-uo;
    csv += `=== SALDO ===\nLucro Uber;Despesas Casa;Saldo\n${unet};${pt};${unet-pt}\n`;
    downloadCSV(csv, `Uber_${m}.csv`);
}


// =====================================================
// =====================================================
//  ROUPAS MODULE
// =====================================================
// =====================================================
async function startRoupasSession() {
    document.getElementById('roupasApp').classList.remove('hidden');
    document.getElementById('roupasHeaderUserName').textContent = currentUser.name;

    document.getElementById('roupasLogoutBtn').onclick = handleLogout;
    document.getElementById('roupasSyncBtn').onclick = () => window.manualCloudSync('roupasSyncBtn', 'roupasSyncTime');

    loadRoupasSettings();
    loadEstoque();
    loadCompras();
    loadVendas();

    // Sincronizar com banco de dados na nuvem/hospedagem
    await syncCloudLoad();

    document.getElementById('compraData').value = todayISO();
    document.getElementById('vendaData').value = todayISO();
    document.getElementById('estoqueDataEntrada').value = todayISO();

    populateRoupasMonthFilter();
    setupRoupasMonthFilter();
    setupRoupasTabNav();
    setupRoupasListeners();
    renderRoupasApp();

    // Daily backup check
    checkAndRunDailyBackup();
}

// ----- Storage -----
function loadRoupasSettings() {
    const d = localStorage.getItem(userKey('roupas_finance_settings'));
    roupasSettings = d ? JSON.parse(d) : {
        backupEmail: '',
        emailjsServiceId: '',
        emailjsTemplateId: '',
        emailjsPublicKey: ''
    };
}
function saveRoupasSettings() { 
    localStorage.setItem(userKey('roupas_finance_settings'), JSON.stringify(roupasSettings)); 
    syncCloudSave();
}

function loadEstoque() {
    const d = localStorage.getItem(userKey('roupas_estoque'));
    estoqueItems = d ? JSON.parse(d) : [];
}
function saveEstoque() { 
    localStorage.setItem(userKey('roupas_estoque'), JSON.stringify(estoqueItems)); 
    syncCloudSave();
}

function loadCompras() {
    const d = localStorage.getItem(userKey('roupas_compras'));
    comprasEntries = d ? JSON.parse(d) : [];
}
function saveCompras() { 
    localStorage.setItem(userKey('roupas_compras'), JSON.stringify(comprasEntries)); 
    syncCloudSave();
}

function loadVendas() {
    const d = localStorage.getItem(userKey('roupas_vendas'));
    vendasEntries = d ? JSON.parse(d) : [];
}
function saveVendas() { 
    localStorage.setItem(userKey('roupas_vendas'), JSON.stringify(vendasEntries)); 
    syncCloudSave();
}

// ----- Tabs -----
function setupRoupasTabNav() {
    document.querySelectorAll('#roupasTabsNav .tab-btn').forEach(btn => {
        btn.onclick = () => {
            document.querySelectorAll('#roupasTabsNav .tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('#roupasApp .rtab-content').forEach(c => c.classList.remove('active'));
            btn.classList.add('active');
            document.getElementById(btn.dataset.rtab).classList.add('active');
            renderRoupasApp();
        };
    });
}

// ----- Month Filter -----
function populateRoupasMonthFilter() {
    const select = document.getElementById('roupasMonthFilter');
    const prev = select.value;
    const months = new Set([new Date().toISOString().substring(0, 7)]);
    comprasEntries.forEach(e => months.add(monthKey(e.data)));
    vendasEntries.forEach(e => months.add(monthKey(e.data)));
    const sorted = Array.from(months).sort().reverse();
    select.innerHTML = sorted.map(m => {
        const [yr, mo] = m.split('-');
        const lbl = new Date(+yr, +mo - 1, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
        return `<option value="${m}">${lbl.charAt(0).toUpperCase() + lbl.slice(1)}</option>`;
    }).join('');
    if (prev && sorted.includes(prev)) select.value = prev;
}

function setupRoupasMonthFilter() {
    document.getElementById('roupasMonthFilter').onchange = renderRoupasApp;
}

// ----- Listeners -----
function setupRoupasListeners() {
    // Estoque form toggle
    document.getElementById('openAddEstoqueBtn').onclick = () => {
        resetEstoqueForm();
        document.getElementById('estoqueFormWrapper').classList.remove('hidden');
    };
    document.getElementById('cancelEstoqueBtn').onclick = () => {
        document.getElementById('estoqueFormWrapper').classList.add('hidden');
        resetEstoqueForm();
    };
    document.getElementById('estoqueForm').onsubmit = handleEstoqueSubmit;

    // Compras
    document.getElementById('compraForm').onsubmit = handleCompraSubmit;
    document.getElementById('cancelCompraBtn').onclick = resetCompraForm;
    document.getElementById('clearComprasBtn').onclick = () => {
        const m = document.getElementById('roupasMonthFilter').value;
        if (confirm(`Apagar compras de ${m}?`)) {
            const toDel = comprasEntries.filter(e => monthKey(e.data) === m);
            toDel.forEach(e => deleteCloudItem('compras_entries', e.id));
            comprasEntries = comprasEntries.filter(e => monthKey(e.data) !== m);
            saveCompras(); populateRoupasMonthFilter(); renderRoupasApp();
        }
    };

    // Vendas
    document.getElementById('vendaForm').onsubmit = handleVendaSubmit;
    document.getElementById('cancelVendaBtn').onclick = resetVendaForm;
    document.getElementById('clearVendasBtn').onclick = () => {
        const m = document.getElementById('roupasMonthFilter').value;
        if (confirm(`Apagar vendas de ${m}?`)) {
            const toDel = vendasEntries.filter(e => monthKey(e.data) === m);
            toDel.forEach(e => deleteCloudItem('vendas_entries', e.id));
            vendasEntries = vendasEntries.filter(e => monthKey(e.data) !== m);
            saveVendas(); populateRoupasMonthFilter(); renderRoupasApp();
        }
    };

    // Auto-preencher custo de ref e calcular lucro quando produto selecionado
    document.getElementById('vendaProdutoSelect').addEventListener('change', autoFillVendaCusto);
    document.getElementById('vendaValor').addEventListener('input', calcVendaLucroPreview);
    document.getElementById('vendaCustoRef').addEventListener('input', calcVendaLucroPreview);
    document.getElementById('vendaQtd').addEventListener('input', () => { autoFillVendaCusto(); calcVendaLucroPreview(); });

    // Export
    document.getElementById('roupasExportCsvBtn').onclick = exportRoupasCSV;

    // Roupas Settings & Backup listeners
    document.getElementById('openRoupasSettingsBtn').onclick = () => {
        document.getElementById('rBackupEmail').value = roupasSettings.backupEmail || '';
        document.getElementById('rEmailjsServiceId').value = roupasSettings.emailjsServiceId || '';
        document.getElementById('rEmailjsTemplateId').value = roupasSettings.emailjsTemplateId || '';
        document.getElementById('rEmailjsPublicKey').value = roupasSettings.emailjsPublicKey || '';
        document.getElementById('roupasSettingsModal').classList.remove('hidden');
    };
    document.getElementById('closeRoupasSettingsBtn').onclick = () => document.getElementById('roupasSettingsModal').classList.add('hidden');
    document.getElementById('cancelRoupasSettingsBtn').onclick = () => document.getElementById('roupasSettingsModal').classList.add('hidden');
    document.getElementById('roupasSettingsForm').onsubmit = e => {
        e.preventDefault();
        roupasSettings.backupEmail = document.getElementById('rBackupEmail').value.trim();
        roupasSettings.emailjsServiceId = document.getElementById('rEmailjsServiceId').value.trim();
        roupasSettings.emailjsTemplateId = document.getElementById('rEmailjsTemplateId').value.trim();
        roupasSettings.emailjsPublicKey = document.getElementById('rEmailjsPublicKey').value.trim();
        saveRoupasSettings();
        document.getElementById('roupasSettingsModal').classList.add('hidden');
        showToast('Configurações salvas com sucesso!', 'success');
    };

    document.getElementById('rManualBackupBtn').onclick = () => {
        downloadJSONBackup();
        showToast('Backup JSON baixado com sucesso!', 'success');
    };
    document.getElementById('rTestEmailBtn').onclick = () => sendEmailBackup(true);
}

// ----- Main Render -----
function renderRoupasApp() {
    const m = document.getElementById('roupasMonthFilter').value;

    updateProdutoDatalist();
    renderEstoqueTab();

    const comprasM = comprasEntries.filter(e => monthKey(e.data) === m).sort((a,b) => new Date(a.data)-new Date(b.data));
    renderComprasTab(comprasM);

    const vendasM = vendasEntries.filter(e => monthKey(e.data) === m).sort((a,b) => new Date(a.data)-new Date(b.data));
    renderVendasTab(vendasM);

    renderRoupasResumo(comprasM, vendasM);
}

// ----- Estoque Tab -----
function renderEstoqueTab() {
    let totalItems=0, totalCusto=0, totalVenda=0;
    estoqueItems.forEach(e => {
        totalItems += +e.qtd||0;
        totalCusto += (+e.qtd||0) * (+e.custo||0);
        totalVenda += (+e.qtd||0) * (+e.precoVenda||0);
    });

    document.getElementById('kpiEstoqueItens').textContent = totalItems;
    document.getElementById('kpiEstoqueTipos').textContent = `${estoqueItems.length} modelo(s) diferente(s)`;
    document.getElementById('kpiEstoqueValorCusto').textContent = fmtR(totalCusto);
    document.getElementById('kpiEstoqueValorVenda').textContent = fmtR(totalVenda);

    const tbody = document.getElementById('estoqueTableBody');
    tbody.innerHTML = estoqueItems.length === 0 ? emptyRow(9, 'Nenhum produto no estoque.') : estoqueItems.map(item => {
        const custo = +item.custo||0;
        const venda = +item.precoVenda||0;
        const margem = custo > 0 ? (((venda-custo)/custo)*100).toFixed(1) : '-';
        const margemColor = custo>0 && venda>custo ? 'text-success' : custo>0 ? 'text-danger' : '';
        const qtdClass = item.qtd === 0 ? 'text-danger fw-bold' : item.qtd <= 3 ? 'text-warning fw-bold' : '';
        return `<tr>
            <td><strong>${item.nome}</strong></td>
            <td><span class="badge-roupas">${item.categoria||'Outros'}</span></td>
            <td><span class="badge-category">${item.tamanho||'M'}</span></td>
            <td class="${qtdClass}"><strong>${item.qtd||0} un.</strong></td>
            <td>${fmtR(custo)}</td>
            <td>${fmtR(venda)}</td>
            <td class="${margemColor}">${margem !== '-' ? margem + '%' : '-'}</td>
            <td>${dateBR(item.dataEntrada)||'-'}</td>
            <td class="text-center"><div class="action-btns">
                <button class="action-btn action-edit" onclick="editEstoque('${item.id}')"><i class="fa-solid fa-pen"></i></button>
                <button class="action-btn action-delete" onclick="deleteEstoque('${item.id}')"><i class="fa-solid fa-trash"></i></button>
            </div></td>
        </tr>`;
    }).join('');
}

// ----- Compras Tab -----
function renderComprasTab(data) {
    let mercadoria=0, transporte=0;
    data.forEach(e => { mercadoria += +e.custo||0; transporte += +e.transporte||0; });
    const total = mercadoria + transporte;

    document.getElementById('kpiComprasMercadoria').textContent = fmtR(mercadoria);
    document.getElementById('kpiComprasCount').textContent = `${data.length} compra(s) no mês`;
    document.getElementById('kpiComprasTransporte').textContent = fmtR(transporte);
    document.getElementById('kpiComprasTotal').textContent = fmtR(total);

    const tbody = document.getElementById('comprasTableBody');
    tbody.innerHTML = data.length === 0 ? emptyRow(8, 'Nenhuma compra registrada.') : data.map(item => {
        const c = +item.custo||0, t = +item.transporte||0;
        return `<tr>
            <td><strong>${dateBR(item.data)}</strong></td>
            <td>${item.produto}</td>
            <td>${item.qtd||'-'}</td>
            <td class="text-danger">${fmtR(c)}</td>
            <td class="text-danger">${fmtR(t)}</td>
            <td class="text-danger"><strong>${fmtR(c+t)}</strong></td>
            <td>${item.fornecedor||'-'}</td>
            <td class="text-center"><div class="action-btns">
                <button class="action-btn action-edit" onclick="editCompra('${item.id}')"><i class="fa-solid fa-pen"></i></button>
                <button class="action-btn action-delete" onclick="deleteCompra('${item.id}')"><i class="fa-solid fa-trash"></i></button>
            </div></td>
        </tr>`;
    }).join('');

    document.getElementById('footComprasMercadoria').innerHTML = `<strong>${fmtR(mercadoria)}</strong>`;
    document.getElementById('footComprasTransporte').innerHTML = `<strong>${fmtR(transporte)}</strong>`;
    document.getElementById('footComprasTotal').innerHTML = `<strong>${fmtR(total)}</strong>`;

    renderComprasChart(data);
    return { mercadoria, transporte, total };
}

// ----- Vendas Tab -----
function renderVendasTab(data) {
    let totalVendas=0, totalCusto=0, totalLucro=0;
    data.forEach(e => {
        totalVendas += +e.valor||0;
        totalCusto += +e.custoRef||0;
        totalLucro += +e.lucro||0;
    });
    const margemMedia = totalVendas > 0 ? (totalLucro/totalVendas*100).toFixed(1) : 0;

    document.getElementById('kpiVendasTotal').textContent = fmtR(totalVendas);
    document.getElementById('kpiVendasCount').textContent = `${data.length} venda(s) realizadas`;
    document.getElementById('kpiVendasCusto').textContent = fmtR(totalCusto);
    document.getElementById('kpiVendasLucro').textContent = fmtR(totalLucro);
    document.getElementById('kpiVendasMargemMedia').textContent = `Margem média: ${margemMedia}%`;

    const tbody = document.getElementById('vendasTableBody');
    tbody.innerHTML = data.length === 0 ? emptyRow(10, 'Nenhuma venda registrada.') : data.map(item => {
        const v = +item.valor||0, c = +item.custoRef||0, l = +item.lucro||0;
        const margem = v > 0 ? (l/v*100).toFixed(1) : '-';
        return `<tr>
            <td><strong>${dateBR(item.data)}</strong></td>
            <td>${item.produto}</td>
            <td><span class="badge-category">${item.tamanho||'-'}</span></td>
            <td><strong>${item.qtd||1}</strong></td>
            <td class="text-success"><strong>${fmtR(v)}</strong></td>
            <td class="text-danger">${fmtR(c)}</td>
            <td class="${l >= 0 ? 'text-success' : 'text-danger'}"><strong>${fmtR(l)}</strong></td>
            <td class="${l >= 0 ? 'text-success' : 'text-danger'}">${margem !== '-' ? margem + '%' : '-'}</td>
            <td>${item.obs||'-'}</td>
            <td class="text-center"><div class="action-btns">
                <button class="action-btn action-edit" onclick="editVenda('${item.id}')"><i class="fa-solid fa-pen"></i></button>
                <button class="action-btn action-delete" onclick="deleteVenda('${item.id}')"><i class="fa-solid fa-trash"></i></button>
            </div></td>
        </tr>`;
    }).join('');

    document.getElementById('footVendasValor').innerHTML = `<strong>${fmtR(totalVendas)}</strong>`;
    document.getElementById('footVendasCusto').innerHTML = `<strong>${fmtR(totalCusto)}</strong>`;
    document.getElementById('footVendasLucro').innerHTML = `<strong>${fmtR(totalLucro)}</strong>`;

    renderVendasChart(data);
    return { totalVendas, totalCusto, totalLucro };
}

// ----- Resumo Roupas -----
function renderRoupasResumo(comprasM, vendasM) {
    const mercadoria = comprasM.reduce((s,e) => s+(+e.custo||0), 0);
    const transporte = comprasM.reduce((s,e) => s+(+e.transporte||0), 0);
    const totalVendas = vendasM.reduce((s,e) => s+(+e.valor||0), 0);
    const custoVendas = vendasM.reduce((s,e) => s+(+e.custoRef||0), 0);
    const totalCustos = mercadoria + transporte + custoVendas;
    const lucro = totalVendas - totalCustos;

    document.getElementById('rSumVendas').textContent = fmtR(totalVendas);
    document.getElementById('rSumCustos').textContent = fmtR(totalCustos);
    document.getElementById('rSumCustosDetail').textContent = `Mercadoria: ${fmtR(mercadoria)} + Transp: ${fmtR(transporte)} + Custo peças: ${fmtR(custoVendas)}`;
    document.getElementById('rSumLucro').textContent = fmtR(lucro);
    document.getElementById('rSumLucroSubtext').textContent = lucro >= 0 ? 'Lucro positivo! Parabéns!' : 'Atenção: gastos superaram as vendas!';
    document.getElementById('rSumLucro').className = lucro >= 0 ? 'text-success' : 'text-danger';

    renderRoupasConsolidadoChart(totalVendas, totalCustos, lucro);
    renderRoupasCustosChart(mercadoria, transporte, custoVendas);
}

// ----- CRUD: Estoque -----
function handleEstoqueSubmit(e) {
    e.preventDefault();
    const id = document.getElementById('estoqueId').value || Date.now().toString();
    const item = {
        id,
        nome: document.getElementById('estoqueName').value.trim(),
        categoria: document.getElementById('estoqueCategory').value,
        tamanho: document.getElementById('estoqueTamanho').value,
        qtd: parseInt(document.getElementById('estoqueQtd').value)||0,
        custo: parseFloat(document.getElementById('estoqueCusto').value)||0,
        precoVenda: parseFloat(document.getElementById('estoquePrecoVenda').value)||0,
        dataEntrada: document.getElementById('estoqueDataEntrada').value
    };
    if (!item.nome) return alert('Informe o nome do produto.');
    if (editingEstoqueId) {
        const i = estoqueItems.findIndex(e => e.id === editingEstoqueId);
        if (i !== -1) estoqueItems[i] = item;
    } else {
        estoqueItems.push(item);
    }
    saveEstoque();
    document.getElementById('estoqueFormWrapper').classList.add('hidden');
    resetEstoqueForm();
    renderRoupasApp();
    showToast(`Produto '${item.nome} (${item.tamanho})' salvo no estoque!`, 'success');
}

window.editEstoque = function(id) {
    const item = estoqueItems.find(e => e.id === id);
    if (!item) return;
    editingEstoqueId = id;
    document.getElementById('estoqueId').value = item.id;
    document.getElementById('estoqueName').value = item.nome;
    document.getElementById('estoqueCategory').value = item.categoria||'Camiseta';
    document.getElementById('estoqueTamanho').value = item.tamanho||'M';
    document.getElementById('estoqueQtd').value = item.qtd;
    document.getElementById('estoqueCusto').value = item.custo;
    document.getElementById('estoquePrecoVenda').value = item.precoVenda;
    document.getElementById('estoqueDataEntrada').value = item.dataEntrada||'';
    document.getElementById('estoqueFormWrapper').classList.remove('hidden');
    document.getElementById('saveEstoqueBtn').innerHTML = '<i class="fa-solid fa-check"></i> Atualizar Produto';
    document.getElementById('estoqueFormWrapper').scrollIntoView({ behavior: 'smooth', block: 'center' });
};

window.deleteEstoque = function(id) {
    if (!confirm('Excluir este produto do estoque?')) return;
    estoqueItems = estoqueItems.filter(e => e.id !== id);
    deleteCloudItem('estoque_items', id);
    saveEstoque(); renderRoupasApp();
};

function resetEstoqueForm() {
    document.getElementById('estoqueForm').reset();
    document.getElementById('estoqueId').value = '';
    document.getElementById('estoqueDataEntrada').value = todayISO();
    editingEstoqueId = null;
    document.getElementById('saveEstoqueBtn').innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Salvar Produto';
}

// ----- CRUD: Compras -----
function handleCompraSubmit(e) {
    e.preventDefault();
    const id = document.getElementById('compraId').value || Date.now().toString();
    const data = document.getElementById('compraData').value;
    if (!data) return alert('Informe a data.');
    const entry = {
        id, data,
        produto: document.getElementById('compraProduto').value.trim(),
        qtd: parseInt(document.getElementById('compraQtd').value)||null,
        custo: parseFloat(document.getElementById('compraCusto').value)||0,
        transporte: parseFloat(document.getElementById('compraTransporte').value)||0,
        fornecedor: document.getElementById('compraFornecedor').value.trim()
    };
    if (editingCompraId) {
        const i = comprasEntries.findIndex(e => e.id === editingCompraId);
        if (i !== -1) comprasEntries[i] = entry;
    } else {
        comprasEntries.push(entry);
    }
    saveCompras();
    document.getElementById('roupasMonthFilter').value = monthKey(data);
    populateRoupasMonthFilter();
    document.getElementById('roupasMonthFilter').value = monthKey(data);
    resetCompraForm();
    renderRoupasApp();
}

window.editCompra = function(id) {
    const item = comprasEntries.find(e => e.id === id);
    if (!item) return;
    editingCompraId = id;
    document.getElementById('compraId').value = item.id;
    document.getElementById('compraData').value = item.data;
    document.getElementById('compraProduto').value = item.produto;
    document.getElementById('compraQtd').value = item.qtd||'';
    document.getElementById('compraCusto').value = item.custo;
    document.getElementById('compraTransporte').value = item.transporte||'';
    document.getElementById('compraFornecedor').value = item.fornecedor||'';
    document.getElementById('compraFormTitle').textContent = 'Editar Compra';
    document.getElementById('saveCompraBtn').innerHTML = '<i class="fa-solid fa-check"></i> Atualizar';
    document.getElementById('cancelCompraBtn').classList.remove('hidden');
    document.getElementById('compraForm').scrollIntoView({ behavior: 'smooth', block: 'center' });
};

window.deleteCompra = function(id) {
    if (!confirm('Excluir esta compra?')) return;
    comprasEntries = comprasEntries.filter(e => e.id !== id);
    deleteCloudItem('compras_entries', id);
    saveCompras(); populateRoupasMonthFilter(); renderRoupasApp();
};

function resetCompraForm() {
    document.getElementById('compraForm').reset();
    document.getElementById('compraId').value = '';
    document.getElementById('compraData').value = todayISO();
    editingCompraId = null;
    document.getElementById('compraFormTitle').textContent = 'Nova Compra de Mercadoria';
    document.getElementById('saveCompraBtn').innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Salvar Compra';
    document.getElementById('cancelCompraBtn').classList.add('hidden');
}

// ----- CRUD: Vendas -----
function autoFillVendaCusto() {
    const stockId = document.getElementById('vendaProdutoSelect').value;
    const qtd = parseInt(document.getElementById('vendaQtd').value)||1;
    const infoBox = document.getElementById('vendaStockInfo');
    const infoText = document.getElementById('vendaStockInfoText');
    const found = estoqueItems.find(e => e.id === stockId);

    if (found) {
        infoBox.classList.remove('hidden');
        infoText.innerHTML = `<strong>${found.nome}</strong> (Tamanho: <strong>${found.tamanho||'M'}</strong>) &bull; Estoque disponível: <strong>${found.qtd} un.</strong> &bull; Custo Unit: ${fmtR(found.custo)}`;
        
        if (found.custo) {
            document.getElementById('vendaCustoRef').value = (found.custo * qtd).toFixed(0);
        }
        if (found.precoVenda && (!document.getElementById('vendaValor').value || editingVendaId === null)) {
            document.getElementById('vendaValor').value = (found.precoVenda * qtd).toFixed(0);
        }
        calcVendaLucroPreview();
    } else {
        infoBox.classList.add('hidden');
    }
}

function calcVendaLucroPreview() {
    const valor = parseFloat(document.getElementById('vendaValor').value)||0;
    const custo = parseFloat(document.getElementById('vendaCustoRef').value)||0;
    const lucro = valor - custo;
    document.getElementById('vendaLucroVal').textContent = fmtR(lucro);
    document.getElementById('vendaLucroVal').className = lucro >= 0 ? 'text-success' : 'text-danger';
}

function handleVendaSubmit(e) {
    e.preventDefault();
    const id = document.getElementById('vendaId').value || Date.now().toString();
    const data = document.getElementById('vendaData').value;
    if (!data) return alert('Informe a data da venda.');

    const stockId = document.getElementById('vendaProdutoSelect').value;
    const stockItem = estoqueItems.find(e => e.id === stockId);

    if (!stockItem) {
        return alert('Selecione uma peça válida do estoque.');
    }

    const qtd = parseInt(document.getElementById('vendaQtd').value)||1;
    const valor = parseFloat(document.getElementById('vendaValor').value)||0;
    const custoRef = parseFloat(document.getElementById('vendaCustoRef').value)||0;

    if (!editingVendaId && qtd > stockItem.qtd) {
        if (!confirm(`Atenção: A quantidade vendida (${qtd} un.) é maior do que o estoque disponível (${stockItem.qtd} un.). Deseja continuar mesmo assim?`)) {
            return;
        }
    }

    const entry = {
        id,
        data,
        stockItemId: stockItem.id,
        produto: stockItem.nome,
        tamanho: stockItem.tamanho || 'M',
        qtd,
        valor,
        custoRef,
        lucro: valor - custoRef,
        obs: document.getElementById('vendaObs').value.trim()
    };

    if (editingVendaId) {
        const i = vendasEntries.findIndex(e => e.id === editingVendaId);
        if (i !== -1) vendasEntries[i] = entry;
    } else {
        vendasEntries.push(entry);
        // Retirar automaticamente do estoque
        stockItem.qtd = Math.max(0, (stockItem.qtd || 0) - qtd);
        saveEstoque();
        showToast(`✅ Venda salva! Retiradas ${qtd} un. de '${stockItem.nome} (${stockItem.tamanho})'. Novo estoque: ${stockItem.qtd} un.`, 'success');
    }

    saveVendas();
    document.getElementById('roupasMonthFilter').value = monthKey(data);
    populateRoupasMonthFilter();
    document.getElementById('roupasMonthFilter').value = monthKey(data);
    resetVendaForm();
    renderRoupasApp();
}

window.editVenda = function(id) {
    const item = vendasEntries.find(e => e.id === id);
    if (!item) return;
    editingVendaId = id;
    document.getElementById('vendaId').value = item.id;
    document.getElementById('vendaData').value = item.data;
    if (item.stockItemId) document.getElementById('vendaProdutoSelect').value = item.stockItemId;
    document.getElementById('vendaQtd').value = item.qtd;
    document.getElementById('vendaValor').value = item.valor;
    document.getElementById('vendaCustoRef').value = item.custoRef||'';
    document.getElementById('vendaObs').value = item.obs||'';
    document.getElementById('vendaFormTitle').textContent = 'Editar Venda';
    document.getElementById('saveVendaBtn').innerHTML = '<i class="fa-solid fa-check"></i> Atualizar Venda';
    document.getElementById('cancelVendaBtn').classList.remove('hidden');
    autoFillVendaCusto();
    document.getElementById('vendaForm').scrollIntoView({ behavior: 'smooth', block: 'center' });
};

window.deleteVenda = function(id) {
    if (!confirm('Excluir esta venda?')) return;
    vendasEntries = vendasEntries.filter(e => e.id !== id);
    deleteCloudItem('vendas_entries', id);
    saveVendas(); populateRoupasMonthFilter(); renderRoupasApp();
};

function resetVendaForm() {
    document.getElementById('vendaForm').reset();
    document.getElementById('vendaId').value = '';
    document.getElementById('vendaData').value = todayISO();
    document.getElementById('vendaStockInfo').classList.add('hidden');
    editingVendaId = null;
    document.getElementById('vendaFormTitle').textContent = 'Nova Venda';
    document.getElementById('saveVendaBtn').innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Registrar Venda';
    document.getElementById('cancelVendaBtn').classList.add('hidden');
    document.getElementById('vendaLucroVal').textContent = fmtR(0);
}

// ----- Select Options for Vendas -----
function updateProdutoDatalist() {
    const select = document.getElementById('vendaProdutoSelect');
    if (!select) return;
    const prevVal = select.value;

    select.innerHTML = '<option value="">-- Selecione uma peça em estoque --</option>' +
        estoqueItems.map(item => {
            const statusQtd = item.qtd === 0 ? ' (ESGOTADO)' : ` (${item.qtd} un. em estoque)`;
            return `<option value="${item.id}">${item.nome} - Tamanho: ${item.tamanho||'M'}${statusQtd}</option>`;
        }).join('');

    if (prevVal) select.value = prevVal;

    const names = estoqueItems.map(e => `<option value="${e.nome}">`).join('');
    const compraDatalist = document.getElementById('estoqueNamesCompra');
    if (compraDatalist) compraDatalist.innerHTML = names;
}

// ----- Roupas Charts -----
function renderComprasChart(data) {
    const ctx = document.getElementById('comprasChart');
    if (!ctx) return;
    if (charts.compras) charts.compras.destroy();
    charts.compras = new Chart(ctx.getContext('2d'), {
        type: 'bar',
        data: {
            labels: data.map(e => `${dateBR(e.data)} - ${e.produto}`),
            datasets: [
                { label: 'Mercadoria (₲)', data: data.map(e => +e.custo||0), backgroundColor: 'rgba(139,92,246,.7)' },
                { label: 'Transporte (₲)', data: data.map(e => +e.transporte||0), backgroundColor: 'rgba(245,158,11,.7)' },
            ]
        },
        options: chartOpts('₲')
    });
}

function renderVendasChart(data) {
    const ctx = document.getElementById('vendasChart');
    if (!ctx) return;
    if (charts.vendas) charts.vendas.destroy();
    charts.vendas = new Chart(ctx.getContext('2d'), {
        type: 'bar',
        data: {
            labels: data.map(e => `${dateBR(e.data)} - ${e.produto}`),
            datasets: [
                { label: 'Valor Venda', data: data.map(e => +e.valor||0), backgroundColor: 'rgba(59,130,246,.7)' },
                { label: 'Custo', data: data.map(e => +e.custoRef||0), backgroundColor: 'rgba(239,68,68,.7)' },
                { label: 'Lucro', data: data.map(e => +e.lucro||0), type: 'line', borderColor: '#10b981', backgroundColor: 'rgba(16,185,129,.1)', tension: .3 }
            ]
        },
        options: chartOpts('₲')
    });
}

function renderRoupasConsolidadoChart(vendas, custos, lucro) {
    const ctx = document.getElementById('roupasConsolidadoChart');
    if (!ctx) return;
    if (charts.roupasConsolidado) charts.roupasConsolidado.destroy();
    charts.roupasConsolidado = new Chart(ctx.getContext('2d'), {
        type: 'bar',
        data: {
            labels: ['Total Vendas', 'Total Custos', 'Lucro Líquido'],
            datasets: [{ label: 'Valor (₲)', data: [vendas, custos, lucro], backgroundColor: ['rgba(59,130,246,.8)','rgba(239,68,68,.7)','rgba(16,185,129,.8)'], borderRadius: 8 }]
        },
        options: { ...chartOpts('₲'), plugins: { legend: { display: false } } }
    });
}

function renderRoupasCustosChart(mercadoria, transporte, custoVendas) {
    const ctx = document.getElementById('roupasCustosChart');
    if (!ctx) return;
    if (charts.roupasCustos) charts.roupasCustos.destroy();
    charts.roupasCustos = new Chart(ctx.getContext('2d'), {
        type: 'doughnut',
        data: {
            labels: ['Mercadoria', 'Transporte/Frete', 'Custo das Peças Vendidas'],
            datasets: [{ data: [mercadoria, transporte, custoVendas], backgroundColor: ['#8b5cf6','#f59e0b','#ef4444'] }]
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right', labels: { color: '#94a3b8' } } } }
    });
}

// ----- Roupas CSV -----
function exportRoupasCSV() {
    const m = document.getElementById('roupasMonthFilter').value;
    const comprasM = comprasEntries.filter(e => monthKey(e.data) === m);
    const vendasM = vendasEntries.filter(e => monthKey(e.data) === m);
    let csv = '\uFEFF';

    csv += `=== ESTOQUE (total) ===\n`;
    csv += `Produto;Categoria;Qtd;Custo Unit;Preco Venda;Data Entrada\n`;
    estoqueItems.forEach(e => { csv += `"${e.nome}";${e.categoria||''};${e.qtd||0};${e.custo||0};${e.precoVenda||0};${dateBR(e.dataEntrada)}\n`; });

    csv += `\n=== COMPRAS (${m}) ===\n`;
    csv += `Data;Produto;Qtd;Custo Mercadoria;Transporte;Total;Fornecedor\n`;
    let cm=0, ct=0;
    comprasM.forEach(e => { const c=+e.custo||0, t=+e.transporte||0; cm+=c; ct+=t; csv += `${dateBR(e.data)};"${e.produto}";${e.qtd||''};${c};${t};${c+t};"${e.fornecedor||''}"\n`; });
    csv += `TOTAL;;;${cm};${ct};${cm+ct};\n`;

    csv += `\n=== VENDAS (${m}) ===\n`;
    csv += `Data;Produto;Qtd;Valor Venda;Custo Ref;Lucro;Obs\n`;
    let vv=0, vc=0, vl=0;
    vendasM.forEach(e => { const v=+e.valor||0, c=+e.custoRef||0, l=+e.lucro||0; vv+=v; vc+=c; vl+=l; csv += `${dateBR(e.data)};"${e.produto}";${e.qtd||1};${v};${c};${l};"${e.obs||''}"\n`; });
    csv += `TOTAL;;;${vv};${vc};${vl};\n`;

    csv += `\n=== RESUMO (${m}) ===\nVendas;Custos Totais;Lucro Liquido\n${vv};${cm+ct+vc};${vv-(cm+ct+vc)}\n`;
    downloadCSV(csv, `Roupas_${m}.csv`);
}


// =====================================================
// SHARED UTILITIES
// =====================================================
function chartOpts(symbol) {
    return {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { labels: { color: '#94a3b8' } } },
        scales: {
            x: { ticks: { color: '#94a3b8' } },
            y: { ticks: { color: '#94a3b8', callback: v => symbol + ' ' + v.toLocaleString() } }
        }
    };
}

function emptyRow(cols, msg = 'Nenhum registro neste período.') {
    return `<tr><td colspan="${cols}" class="empty-state"><i class="fa-regular fa-folder-open"></i><p>${msg}</p></td></tr>`;
}

function downloadCSV(content, filename) {
    const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

// =====================================================
// =====================================================
//  GRÁFICA RÁPIDA MODULE
// =====================================================
// =====================================================
async function startGraficaSession() {
    document.getElementById('graficaApp').classList.remove('hidden');
    document.getElementById('graficaHeaderUserName').textContent = currentUser.name;

    document.getElementById('graficaLogoutBtn').onclick = handleLogout;
    document.getElementById('graficaSyncBtn').onclick = () => window.manualCloudSync('graficaSyncBtn', 'graficaSyncTime');

    loadGraficaSettings();
    loadGraficaProdutos();
    loadGraficaVendas();
    loadGraficaDespesasOp();
    loadGraficaDespesasPessoais();

    // Sync cloud data
    await syncCloudLoad();

    setupGraficaTabs();
    setupGraficaCalculators();
    setupGraficaForms();
    setupGraficaSettingsModal();

    document.getElementById('exportGraficaCsvBtn').onclick = exportGraficaCsv;

    renderGraficaApp();
}

function loadGraficaSettings() {
    const d = localStorage.getItem(userKey('grafica_settings'));
    graficaSettings = d ? JSON.parse(d) : {
        backupEmail: '',
        emailjsServiceId: '',
        emailjsTemplateId: '',
        emailjsPublicKey: ''
    };
    loadGraficaPrices();
}
function saveGraficaSettings() {
    localStorage.setItem(userKey('grafica_settings'), JSON.stringify(graficaSettings));
    syncCloudSave();
}

function loadGraficaProdutos() {
    const d = localStorage.getItem(userKey('grafica_produtos'));
    graficaProdutos = d ? JSON.parse(d) : [];
    
    if (!localStorage.getItem(userKey('grafica_seeded'))) {
        seedGraficaProdutos();
        localStorage.setItem(userKey('grafica_seeded'), 'true');
    }
}
function saveGraficaProdutos() {
    localStorage.setItem(userKey('grafica_produtos'), JSON.stringify(graficaProdutos));
    syncCloudSave();
}

function loadGraficaPrices() {
    if (graficaSettings && graficaSettings.prices) {
        graficaPrices = graficaSettings.prices;
    } else {
        const d = localStorage.getItem(userKey('grafica_prices'));
        graficaPrices = d ? JSON.parse(d) : {};
    }
}
function saveGraficaPrices() {
    graficaSettings.prices = graficaPrices;
    saveGraficaSettings();
    showToast('Tabela de Preços salva!', 'success');
}

function seedGraficaProdutos() {
    const defaultProds = [
        // Plotter (Manted for compatibility)
        { cat: 'Plotter / Banner', n: 'Adesivo Vinil Branco', tipoCalculo: 'm2' },
        { cat: 'Plotter / Banner', n: 'Lona', tipoCalculo: 'm2' },
        
        // A4 (Manted for compatibility)
        { cat: 'Impressão A4', n: 'Sulfite', tipoCalculo: 'a4' },
        
        // Matriz Cartão de Visita
        {
            cat: 'Cartão de Visita',
            n: 'Cartão de Visita Couchê 250g 4x0 UV Total',
            baseName: 'Cartão de Visita',
            material: 'Couchê 250g',
            cor: '4x0',
            cobertura: 'UV Total Frente',
            tamanho: '9x5 cm',
            acabamentoIncluso: 'Sem Acabamento',
            tipoCalculo: 'matriz',
            precosLote: {
                "100": { preco: 39, custo: 20 },
                "250": { preco: 41, custo: 21 },
                "500": { preco: 47, custo: 24 },
                "1000": { preco: 66, custo: 30 },
                "3000": { preco: 191, custo: 80 },
                "5000": { preco: 306, custo: 130 }
            }
        },
        // Matriz Panfleto
        {
            cat: 'Panfleto / Folheto',
            n: 'Panfleto 10x14 Couchê 150g 4x0',
            baseName: 'Panfleto',
            material: 'Couchê 150g',
            cor: '4x0',
            cobertura: 'Sem Verniz',
            tamanho: '10x14 cm',
            acabamentoIncluso: 'Refile',
            tipoCalculo: 'matriz',
            precosLote: {
                "1000": { preco: 90, custo: 45 },
                "2500": { preco: 150, custo: 70 },
                "5000": { preco: 250, custo: 120 }
            }
        }
    ];

    const newProds = defaultProds.map((p, idx) => ({
        id: 'seed_matrix_' + idx + '_' + Date.now().toString(),
        tipo: 'padronizado',
        nome: p.n,
        categoria: p.cat,
        tipoCalculo: p.tipoCalculo || 'unitario',
        baseName: p.baseName || '',
        material: p.material || '',
        cor: p.cor || '',
        cobertura: p.cobertura || '',
        tamanho: p.tamanho || '',
        acabamentoIncluso: p.acabamentoIncluso || '',
        precosLote: p.precosLote || null,
        
        // Fallbacks para legado
        custoUnitario: 0,
        margemLucro: 100,
        precoVenda: 0,
        qtdEstoque: 1000,
        estoqueMinimo: 100
    }));

    graficaProdutos = [...graficaProdutos, ...newProds];
    saveGraficaProdutos();
}
function saveGraficaProdutos() {
    localStorage.setItem(userKey('grafica_produtos'), JSON.stringify(graficaProdutos));
    syncCloudSave();
}

function loadGraficaVendas() {
    const d = localStorage.getItem(userKey('grafica_vendas'));
    graficaVendas = d ? JSON.parse(d) : [];
}
function saveGraficaVendas() {
    localStorage.setItem(userKey('grafica_vendas'), JSON.stringify(graficaVendas));
    syncCloudSave();
}

function loadGraficaDespesasOp() {
    const d = localStorage.getItem(userKey('grafica_despesas_op'));
    graficaDespesasOp = d ? JSON.parse(d) : [];
}
function saveGraficaDespesasOp() {
    localStorage.setItem(userKey('grafica_despesas_op'), JSON.stringify(graficaDespesasOp));
    syncCloudSave();
}

function loadGraficaDespesasPessoais() {
    const d = localStorage.getItem(userKey('grafica_despesas_pessoais'));
    graficaDespesasPessoais = d ? JSON.parse(d) : [];
}
function saveGraficaDespesasPessoais() {
    localStorage.setItem(userKey('grafica_despesas_pessoais'), JSON.stringify(graficaDespesasPessoais));
    syncCloudSave();
}

// ----- Tabs -----
function setupGraficaTabs() {
    document.querySelectorAll('#graficaTabsNav .tab-btn').forEach(btn => {
        btn.onclick = () => {
            document.querySelectorAll('#graficaTabsNav .tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('#graficaApp .gtab-content').forEach(c => {
                c.classList.remove('active');
                c.style.display = 'none';
            });

            btn.classList.add('active');
            const target = document.getElementById(btn.dataset.gtab);
            if (target) {
                target.classList.add('active');
                target.style.display = 'flex';
            }
            renderGraficaApp();
        };
    });
}

// ----- Month Filter -----
function populateGraficaMonthFilter() {
    const select = document.getElementById('graficaMonthFilter');
    const prev = select.value;
    const months = new Set([new Date().toISOString().substring(0, 7)]);
    graficaVendas.forEach(e => { if (e.data) months.add(monthKey(e.data)); });
    graficaDespesasOp.forEach(e => { if (e.data) months.add(monthKey(e.data)); });
    graficaDespesasPessoais.forEach(e => { if (e.vencimento) months.add(monthKey(e.vencimento)); });

    const sorted = Array.from(months).sort().reverse();
    select.innerHTML = sorted.map(m => {
        const [y, mm] = m.split('-');
        const names = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
        return `<option value="${m}">${names[parseInt(mm,10)-1]} / ${y}</option>`;
    }).join('');

    if (prev && sorted.includes(prev)) select.value = prev;
    select.onchange = () => renderGraficaApp();
}

// ----- Calculators & Balcão -----
function setupGraficaCalculators() {
    // A nova interface do PDV usa renderCategoryGrid() e eventos inline no HTML.
    // Esta função foi esvaziada para evitar conflitos com a versão antiga.
}
const pdvCatalog = [
    // Grupo A: Tiragem Fixa
    {
        id: 'panfleto',
        name: 'Panfleto / Folheto',
        icon: 'fa-file-lines',
        group: 'A',
        papel: ['Couchê 150g'],
        tamanhos: ['10x14cm', '10x15cm', '10x21cm', '14x20cm', '15x21cm', '20x21cm'],
        cores: ['4x0', '4x1', '4x4'],
        tiragens: [1000, 2500, 5000, 10000],
        calcPrice: (tamanho, papel, cor, tiragem) => {
            const tBase = tamanho.includes('20') ? 2 : 1;
            const cBase = cor === '4x4' ? 1.5 : (cor === '4x1' ? 1.2 : 1);
            const tiragemBase = { 1000: 90, 2500: 160, 5000: 250, 10000: 400 };
            return (tiragemBase[tiragem] || 90) * tBase * cBase;
        }
    },
    {
        id: 'cartao',
        name: 'Cartão de Visita',
        icon: 'fa-address-card',
        group: 'A',
        papel: ['Couchê 250g'],
        tamanhos: ['9x4cm'],
        cores: ['4x0', '4x1', '4x4'],
        tiragens: [1000, 2500, 5000, 10000],
        calcPrice: (tamanho, papel, cor, tiragem) => {
            const cBase = cor === '4x4' ? 1.5 : (cor === '4x1' ? 1.2 : 1);
            const tiragemBase = { 1000: 45, 2500: 90, 5000: 150, 10000: 250 };
            return (tiragemBase[tiragem] || 45) * cBase;
        }
    },
    {
        id: 'talao',
        name: 'Talão / Receituário',
        icon: 'fa-receipt',
        group: 'A',
        papel: ['Sulfite Simples', 'Sulfite + Copiativo'],
        tamanhos: ['10x14cm', '10x15cm', '10x21cm', '14x20cm', '15x21cm', '20x21cm'],
        cores: ['4x0', '4x1', '4x4'],
        tiragens: [1000, 2500, 5000, 10000],
        calcPrice: (tamanho, papel, cor, tiragem) => {
            const tBase = tamanho.includes('20') ? 2 : 1;
            const pBase = papel.includes('Copiativo') ? 1.8 : 1;
            const cBase = cor === '4x4' ? 1.5 : 1;
            const tiragemBase = { 1000: 100, 2500: 200, 5000: 350, 10000: 600 };
            return (tiragemBase[tiragem] || 100) * tBase * pBase * cBase;
        }
    },
    // Grupo B: Unidade
    {
        id: 'cracha',
        name: 'Crachá PVC',
        icon: 'fa-id-badge',
        group: 'B',
        papel: ['PVC 0.76mm'],
        tamanhos: ['9x4cm'],
        cores: ['4x0', '4x4'],
        calcPrice: (tamanho, papel, cor, qtd) => {
            const cBase = cor === '4x4' ? 8 : 5;
            return cBase * qtd;
        }
    },
    {
        id: 'cardapio',
        name: 'Cardápio',
        icon: 'fa-book-open',
        group: 'B',
        papel: ['Sulfite', 'Cartão', 'PVC'],
        tamanhos: ['A4'],
        cores: ['4x0', '4x1', '4x4'],
        calcPrice: (tamanho, papel, cor, qtd) => {
            let pBase = 2;
            if(papel === 'Cartão') pBase = 5;
            if(papel === 'PVC') pBase = 15;
            const cBase = cor === '4x4' ? 1.5 : (cor === '4x1' ? 1.2 : 1);
            return (pBase * cBase) * qtd;
        }
    },
    // Grupo C: M²
    {
        id: 'lona',
        name: 'Lona',
        icon: 'fa-scroll',
        group: 'C',
        papel: ['Lona Brilho', 'Lona Fosca'],
        precoM2: 45,
        calcPrice: (l, a, precoM2, qtd) => (l * a * precoM2) * qtd
    },
    {
        id: 'adesivo',
        name: 'Adesivo Vinil',
        icon: 'fa-note-sticky',
        group: 'C',
        papel: ['Branco', 'Transparente', 'Blackout'],
        precoM2: 55,
        calcPrice: (l, a, precoM2, qtd) => (l * a * precoM2) * qtd
    }
];

let pdvCurrentProduct = null;
let pdvCurrentConfig = {};
let pdvCurrentSubtotal = 0;

window.renderCategoryGrid = function() {
    const grid = document.getElementById('categoryGrid');
    if(!grid) return;
    grid.innerHTML = pdvCatalog.map(p => `
        <button type="button" onclick="selectProduct('${p.id}')" class="bg-slate-800 hover:bg-brand-600 border border-slate-700 hover:border-brand-500 rounded-xl p-4 flex flex-col items-center justify-center gap-3 transition-all group cursor-pointer text-white">
            <i class="fa-solid ${p.icon} text-3xl text-slate-400 group-hover:text-white transition-colors"></i>
            <span class="text-sm font-semibold text-slate-300 group-hover:text-white text-center">${p.name}</span>
        </button>
    `).join('');
};

window.selectProduct = function(id) {
    pdvCurrentProduct = pdvCatalog.find(p => p.id === id);
    pdvCurrentConfig = {
        tamanho: pdvCurrentProduct.tamanhos ? pdvCurrentProduct.tamanhos[0] : null,
        papel: pdvCurrentProduct.papel ? pdvCurrentProduct.papel[0] : null,
        cor: pdvCurrentProduct.cores ? pdvCurrentProduct.cores[0] : null,
        tiragem: pdvCurrentProduct.tiragens ? pdvCurrentProduct.tiragens[0] : null,
        qtd: 1, largura: '', altura: '', obs: ''
    };

    document.getElementById('configCategory').innerText = `Grupo ${pdvCurrentProduct.group}`;
    document.getElementById('configTitle').innerText = pdvCurrentProduct.name;
    document.getElementById('itemObs').value = '';

    document.getElementById('emptyConfigurator').classList.add('hidden');
    document.getElementById('configuratorWrapper').classList.remove('hidden');

    renderDynamicForm();
    recalculateConfig();
};

window.resetConfigurator = function() {
    pdvCurrentProduct = null;
    document.getElementById('configuratorWrapper').classList.add('hidden');
    document.getElementById('emptyConfigurator').classList.remove('hidden');
};

window.renderDynamicForm = function() {
    const container = document.getElementById('dynamicFormFields');
    if(!container) return;
    let html = '';

    const createSelect = (label, key, options) => `
        <div class="space-y-1">
            <label class="block text-xs font-medium text-slate-400 uppercase tracking-wider">${label}</label>
            <select class="w-full bg-slate-800 rounded-lg p-3 text-sm text-white border border-slate-700 outline-none focus:ring-2 focus:ring-brand-500" 
                    onchange="updateConfig('${key}', this.value)">
                ${options.map(o => `<option value="${o}" ${pdvCurrentConfig[key] == o ? 'selected' : ''}>${o}</option>`).join('')}
            </select>
        </div>
    `;

    if (pdvCurrentProduct.group === 'A') {
        html += createSelect('Tamanho', 'tamanho', pdvCurrentProduct.tamanhos);
        html += createSelect('Material / Papel', 'papel', pdvCurrentProduct.papel);
        html += createSelect('Cores', 'cor', pdvCurrentProduct.cores);
        html += createSelect('Tiragem (Qtd)', 'tiragem', pdvCurrentProduct.tiragens);
    } 
    else if (pdvCurrentProduct.group === 'B') {
        html += createSelect('Tamanho', 'tamanho', pdvCurrentProduct.tamanhos);
        html += createSelect('Material / Papel', 'papel', pdvCurrentProduct.papel);
        html += createSelect('Cores', 'cor', pdvCurrentProduct.cores);
        html += `
            <div class="space-y-1">
                <label class="block text-xs font-medium text-slate-400 uppercase tracking-wider">Quantidade</label>
                <input type="number" min="1" value="${pdvCurrentConfig.qtd}" 
                       oninput="updateConfig('qtd', this.value)"
                       class="w-full bg-slate-800 rounded-lg p-3 text-sm text-white border border-slate-700 outline-none focus:ring-2 focus:ring-brand-500">
            </div>
        `;
    }
    else if (pdvCurrentProduct.group === 'C') {
        html += createSelect('Material', 'papel', pdvCurrentProduct.papel);
        html += `
            <div class="space-y-1">
                <label class="block text-xs font-medium text-slate-400 uppercase tracking-wider">Largura (m)</label>
                <input type="number" step="0.01" min="0.1" placeholder="Ex: 1.5" value="${pdvCurrentConfig.largura}" 
                       oninput="updateConfig('largura', this.value)"
                       class="w-full bg-slate-800 rounded-lg p-3 text-sm text-white border border-slate-700 outline-none focus:ring-2 focus:ring-brand-500">
            </div>
            <div class="space-y-1">
                <label class="block text-xs font-medium text-slate-400 uppercase tracking-wider">Altura (m)</label>
                <input type="number" step="0.01" min="0.1" placeholder="Ex: 2.0" value="${pdvCurrentConfig.altura}" 
                       oninput="updateConfig('altura', this.value)"
                       class="w-full bg-slate-800 rounded-lg p-3 text-sm text-white border border-slate-700 outline-none focus:ring-2 focus:ring-brand-500">
            </div>
            <div class="space-y-1">
                <label class="block text-xs font-medium text-slate-400 uppercase tracking-wider">Qtd Peças</label>
                <input type="number" min="1" value="${pdvCurrentConfig.qtd}" 
                       oninput="updateConfig('qtd', this.value)"
                       class="w-full bg-slate-800 rounded-lg p-3 text-sm text-white border border-slate-700 outline-none focus:ring-2 focus:ring-brand-500">
            </div>
            <div class="col-span-1 md:col-span-2 text-sm text-slate-400 bg-slate-800/50 p-3 rounded-lg border border-slate-700 mt-2">
                <i class="fa-solid fa-circle-info mr-2"></i> Valor base do Material: <strong>R$ ${pdvCurrentProduct.precoM2.toFixed(2).replace('.',',')} / m²</strong>
            </div>
        `;
    }
    container.innerHTML = html;
};

window.updateConfig = function(key, value) {
    if (['tiragem', 'qtd'].includes(key)) {
        pdvCurrentConfig[key] = parseInt(value) || (key==='tiragem'?1000:1);
    } else if (['largura', 'altura'].includes(key)) {
        pdvCurrentConfig[key] = parseFloat(value) || 0;
    } else {
        pdvCurrentConfig[key] = value;
    }
    recalculateConfig();
};

window.recalculateConfig = function() {
    if (!pdvCurrentProduct) return;

    let calc = 0;
    if (pdvCurrentProduct.group === 'A') {
        const key = `${pdvCurrentProduct.id}_${pdvCurrentConfig.tamanho}_${pdvCurrentConfig.papel}_${pdvCurrentConfig.cor}_${pdvCurrentConfig.tiragem}`;
        const defaultCalc = pdvCurrentProduct.calcPrice(pdvCurrentConfig.tamanho, pdvCurrentConfig.papel, pdvCurrentConfig.cor, pdvCurrentConfig.tiragem);
        calc = getPriceFor(key, defaultCalc);
    } 
    else if (pdvCurrentProduct.group === 'B') {
        const key = `${pdvCurrentProduct.id}_${pdvCurrentConfig.tamanho}_${pdvCurrentConfig.papel}_${pdvCurrentConfig.cor}`;
        // Para o grupo B, o preço na tabela é unitário. O cálculo padrão multiplica pela QTD.
        const cBase = pdvCurrentProduct.baseCores ? pdvCurrentProduct.baseCores[pdvCurrentConfig.cor] : 1;
        const pBase = pdvCurrentProduct.basePrecoUnidade || 1;
        const defaultUnitPrice = cBase * pBase;
        
        const unitPrice = getPriceFor(key, defaultUnitPrice);
        calc = unitPrice * pdvCurrentConfig.qtd;
    } 
    else if (pdvCurrentProduct.group === 'C') {
        const key = `${pdvCurrentProduct.id}_${pdvCurrentConfig.papel}`;
        const defaultM2Price = pdvCurrentProduct.precoM2 || 45;
        const m2Price = getPriceFor(key, defaultM2Price);
        calc = (pdvCurrentConfig.largura * pdvCurrentConfig.altura) * m2Price * pdvCurrentConfig.qtd;
    }
    
    pdvCurrentSubtotal = calc;
    document.getElementById('itemSubtotal').innerText = fmtR(pdvCurrentSubtotal);
};

window.handleAddToCart = function() {
    if (!pdvCurrentProduct) return;

    if (pdvCurrentProduct.group === 'C' && (pdvCurrentConfig.largura <= 0 || pdvCurrentConfig.altura <= 0)) {
        showToast('Informe Largura e Altura maiores que zero.', 'error');
        return;
    }

    const obs = document.getElementById('itemObs').value.trim();
    let details = [];
    if (pdvCurrentConfig.tamanho) details.push(pdvCurrentConfig.tamanho);
    if (pdvCurrentConfig.papel) details.push(pdvCurrentConfig.papel);
    if (pdvCurrentConfig.cor) details.push(pdvCurrentConfig.cor);
    
    let m2Total = null;
    if (pdvCurrentProduct.group === 'C') {
        details.push(`${pdvCurrentConfig.largura}m x ${pdvCurrentConfig.altura}m`);
        m2Total = (pdvCurrentConfig.largura * pdvCurrentConfig.altura) * pdvCurrentConfig.qtd;
    }

    const itemQtd = pdvCurrentProduct.group === 'A' ? pdvCurrentConfig.tiragem : pdvCurrentConfig.qtd;

    const cartItem = {
        produtoId: pdvCurrentProduct.id,
        categoria: pdvCurrentProduct.name,
        detalhes: details.join(' • '),
        obs: obs,
        qtd: itemQtd,
        isLote: pdvCurrentProduct.group === 'A',
        m2Total: m2Total,
        custoTotal: pdvCurrentSubtotal * 0.4, // Custo fake (40% do venda) para DRE
        precoTotal: pdvCurrentSubtotal,
        lucro: pdvCurrentSubtotal * 0.6
    };

    graficaCart.push(cartItem);
    resetConfigurator();
    renderGraficaCart();
    showToast('Adicionado ao carrinho!', 'success');
};

window.duplicateCartItem = function(index) {
    const item = { ...graficaCart[index] };
    graficaCart.push(item);
    renderGraficaCart();
};

window.removeGraficaCartItem = function(index) {
    graficaCart.splice(index, 1);
    renderGraficaCart();
};

window.clearCart = function() {
    if (graficaCart.length > 0 && confirm('Tem certeza que deseja limpar o carrinho?')) {
        graficaCart = [];
        document.getElementById('clientName').value = '';
        document.getElementById('summaryDiscount').value = 0;
        renderGraficaCart();
    }
};

window.renderGraficaCart = function() {
    const list = document.getElementById('cartItemsList');
    if (!list) return;
    
    document.getElementById('cartCountBadge').innerText = `${graficaCart.length} itens`;

    if (graficaCart.length === 0) {
        list.innerHTML = `
            <div class="h-full flex flex-col items-center justify-center text-slate-500 pb-10">
                <i class="fa-solid fa-cart-shopping text-4xl mb-4 opacity-30"></i>
                <p class="text-sm">O carrinho está vazio.</p>
            </div>
        `;
    } else {
        list.innerHTML = graficaCart.map((item, idx) => `
            <div class="bg-slate-900 border border-slate-700 rounded-lg p-3 hover:border-slate-600 transition group">
                <div class="flex justify-between items-start mb-2">
                    <h4 class="font-bold text-slate-200 text-sm m-0">${item.categoria}</h4>
                    <div class="flex gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button type="button" onclick="duplicateCartItem(${idx})" class="text-slate-400 hover:text-brand-400 bg-transparent border-none cursor-pointer p-0"><i class="fa-solid fa-copy"></i></button>
                        <button type="button" onclick="removeGraficaCartItem(${idx})" class="text-slate-400 hover:text-red-400 bg-transparent border-none cursor-pointer p-0"><i class="fa-solid fa-trash"></i></button>
                    </div>
                </div>
                <p class="text-xs text-slate-400 mb-1 leading-tight m-0">${item.detalhes}</p>
                ${item.obs ? `<p class="text-xs text-amber-400 mb-2 mt-1 m-0"><i class="fa-solid fa-comment-dots mr-1"></i>${item.obs}</p>` : ''}
                
                <div class="flex justify-between items-end mt-3 border-t border-slate-800 pt-2">
                    <span class="text-xs text-slate-300 font-medium">Qtd: ${item.isLote ? 'Lote ' : ''}${item.qtd.toLocaleString('pt-BR')}</span>
                    <span class="font-bold text-emerald-400 text-sm">${fmtR(item.precoTotal)}</span>
                </div>
            </div>
        `).join('');
    }

    calculateTotal();
    list.scrollTop = list.scrollHeight;
};

window.calculateTotal = function() {
    const subtotal = graficaCart.reduce((acc, curr) => acc + curr.precoTotal, 0);
    const discountInput = parseFloat(document.getElementById('summaryDiscount').value) || 0;
    
    const total = Math.max(0, subtotal - discountInput);

    document.getElementById('summarySubtotal').innerText = fmtR(subtotal);
    document.getElementById('summaryTotal').innerText = fmtR(total);
};

window.finalizeSale = function() {
    if (graficaCart.length === 0) {
        showToast('O carrinho está vazio.', 'warning');
        return;
    }

    const cliente = document.getElementById('clientName').value.trim() || 'Balcão';
    const formaPagamento = document.getElementById('paymentMethod').value;
    const orderStatus = document.getElementById('orderStatus').value;
    const desconto = parseFloat(document.getElementById('summaryDiscount').value) || 0;
    
    const dataVenda = todayISO();
    
    // Distribui o desconto proporcionalmente para não quebrar o DRE
    const subtotalGeral = graficaCart.reduce((acc, curr) => acc + curr.precoTotal, 0);
    const taxaDesconto = subtotalGeral > 0 ? (desconto / subtotalGeral) : 0;

    graficaCart.forEach(item => {
        const precoComDesconto = item.precoTotal - (item.precoTotal * taxaDesconto);
        const lucroFinal = precoComDesconto - item.custoTotal;
        
        const venda = {
            id: Date.now().toString() + Math.floor(Math.random()*1000), 
            data: dataVenda,
            cliente,
            tipoItem: item.categoria,
            produtoId: item.produtoId,
            detalhes: item.detalhes,
            m2Total: item.m2Total,
            qtd: item.qtd,
            custoTotal: item.custoTotal,
            precoTotal: precoComDesconto,
            lucro: lucroFinal,
            formaPagamento,
            obs: item.obs,
            status: orderStatus
        };
        graficaVendas.unshift(venda);
    });

    saveGraficaVendas();
    showToast(`Venda de ${graficaCart.length} itens finalizada!`, 'success');

    graficaCart = [];
    document.getElementById('clientName').value = '';
    document.getElementById('summaryDiscount').value = 0;
    renderGraficaCart();
    renderGraficaApp();
};


// ----- Forms Setup -----
function setupGraficaForms() {
    // Open product form
    document.getElementById('openAddGraficaProdutoBtn').onclick = () => {
        editingGraficaProdutoId = null;
        document.getElementById('graficaProdutoForm').reset();
        document.getElementById('graficaProdutoId').value = '';
        document.getElementById('graficaProdutoFormWrapper').classList.remove('hidden');
    };
    document.getElementById('cancelGraficaProdutoBtn').onclick = () => {
        document.getElementById('graficaProdutoFormWrapper').classList.add('hidden');
    };

    // Auto margin / price sync
    const costIn = document.getElementById('graficaProdutoCusto');
    const margIn = document.getElementById('graficaProdutoMargem');
    const priceIn = document.getElementById('graficaProdutoPreco');

    if (costIn && margIn && priceIn) {
        costIn.oninput = () => {
            const c = parseFloat(costIn.value) || 0;
            const m = parseFloat(margIn.value) || 0;
            if (c > 0 && m > 0) {
                priceIn.value = (c * (1 + m / 100)).toFixed(2);
            }
        };
        margIn.oninput = () => {
            const c = parseFloat(costIn.value) || 0;
            const m = parseFloat(margIn.value) || 0;
            if (c > 0) {
                priceIn.value = (c * (1 + m / 100)).toFixed(2);
            }
        };
        priceIn.oninput = () => {
            const c = parseFloat(costIn.value) || 0;
            const p = parseFloat(priceIn.value) || 0;
            if (c > 0 && p >= c) {
                margIn.value = (((p - c) / c) * 100).toFixed(1);
            }
        };
    }

    document.getElementById('graficaProdutoForm').onsubmit = (e) => {
        e.preventDefault();
        const id = document.getElementById('graficaProdutoId').value || Date.now().toString();
        const custoUnitario = parseFloat(document.getElementById('graficaProdutoCusto').value) || 0;
        const precoVenda = parseFloat(document.getElementById('graficaProdutoPreco').value) || 0;
        const margemLucro = parseFloat(document.getElementById('graficaProdutoMargem').value) || (custoUnitario > 0 ? (((precoVenda - custoUnitario) / custoUnitario) * 100) : 0);

        const prod = {
            id,
            tipo: 'padronizado',
            nome: document.getElementById('graficaProdutoNome').value.trim(),
            categoria: document.getElementById('graficaProdutoCategoria').value,
            medidas: '',
            tipoPapel: '',
            acabamento: '',
            custoUnitario,
            margemLucro,
            precoVenda,
            qtdEstoque: parseInt(document.getElementById('graficaProdutoEstoque').value) || 0,
            estoqueMinimo: parseInt(document.getElementById('graficaProdutoEstoqueMin').value) || 5
        };

        if (editingGraficaProdutoId) {
            const idx = graficaProdutos.findIndex(p => p.id === editingGraficaProdutoId);
            if (idx !== -1) graficaProdutos[idx] = prod;
        } else {
            graficaProdutos.push(prod);
        }

        saveGraficaProdutos();
        showToast('Produto salvo no catálogo com sucesso!', 'success');
        document.getElementById('graficaProdutoFormWrapper').classList.add('hidden');
        renderGraficaApp();
    };

    // Open Operational Expense Form
    document.getElementById('openAddGraficaDespesaOpBtn').onclick = () => {
        editingGraficaDespesaOpId = null;
        document.getElementById('graficaDespesaOpForm').reset();
        document.getElementById('graficaDespesaOpId').value = '';
        document.getElementById('graficaDespesaOpData').value = todayISO();
        document.getElementById('graficaDespesaOpFormWrapper').classList.remove('hidden');
    };
    document.getElementById('cancelGraficaDespesaOpBtn').onclick = () => {
        document.getElementById('graficaDespesaOpFormWrapper').classList.add('hidden');
    };

    document.getElementById('graficaDespesaOpForm').onsubmit = (e) => {
        e.preventDefault();
        const id = document.getElementById('graficaDespesaOpId').value || Date.now().toString();
        const despesa = {
            id,
            data: document.getElementById('graficaDespesaOpData').value,
            categoria: document.getElementById('graficaDespesaOpCategoria').value,
            descricao: document.getElementById('graficaDespesaOpDescricao').value.trim(),
            valor: parseFloat(document.getElementById('graficaDespesaOpValor').value) || 0,
            status: document.getElementById('graficaDespesaOpStatus').value
        };

        if (editingGraficaDespesaOpId) {
            const idx = graficaDespesasOp.findIndex(d => d.id === editingGraficaDespesaOpId);
            if (idx !== -1) graficaDespesasOp[idx] = despesa;
        } else {
            graficaDespesasOp.unshift(despesa);
        }

        saveGraficaDespesasOp();
        showToast('Despesa operacional registrada!', 'success');
        document.getElementById('graficaDespesaOpFormWrapper').classList.add('hidden');
        renderGraficaApp();
    };

    // Open Personal Expense Form
    document.getElementById('openAddGraficaPessoalBtn').onclick = () => {
        editingGraficaDespesaPessoalId = null;
        document.getElementById('graficaPessoalForm').reset();
        document.getElementById('graficaPessoalId').value = '';
        document.getElementById('graficaPessoalVencimento').value = todayISO();
        document.getElementById('graficaPessoalFormWrapper').classList.remove('hidden');
    };
    document.getElementById('cancelGraficaPessoalBtn').onclick = () => {
        document.getElementById('graficaPessoalFormWrapper').classList.add('hidden');
    };

    document.getElementById('graficaPessoalForm').onsubmit = (e) => {
        e.preventDefault();
        const id = document.getElementById('graficaPessoalId').value || Date.now().toString();
        const despesa = {
            id,
            vencimento: document.getElementById('graficaPessoalVencimento').value,
            pagamento: document.getElementById('graficaPessoalPagamento').value || null,
            categoria: document.getElementById('graficaPessoalCategoria').value,
            descricao: document.getElementById('graficaPessoalDescricao').value.trim(),
            valor: parseFloat(document.getElementById('graficaPessoalValor').value) || 0,
            status: document.getElementById('graficaPessoalStatus').value
        };

        if (editingGraficaDespesaPessoalId) {
            const idx = graficaDespesasPessoais.findIndex(d => d.id === editingGraficaDespesaPessoalId);
            if (idx !== -1) graficaDespesasPessoais[idx] = despesa;
        } else {
            graficaDespesasPessoais.unshift(despesa);
        }

        saveGraficaDespesasPessoais();
        showToast('Despesa pessoal cadastrada!', 'success');
        document.getElementById('graficaPessoalFormWrapper').classList.add('hidden');
        renderGraficaApp();
    };
}

// ----- Settings Modal -----
function setupGraficaSettingsModal() {
    document.getElementById('openGraficaSettingsBtn').onclick = () => {
        document.getElementById('gBackupEmail').value = graficaSettings.backupEmail || '';
        document.getElementById('gEmailjsServiceId').value = graficaSettings.emailjsServiceId || '';
        document.getElementById('gEmailjsTemplateId').value = graficaSettings.emailjsTemplateId || '';
        document.getElementById('gEmailjsPublicKey').value = graficaSettings.emailjsPublicKey || '';
        document.getElementById('graficaSettingsModal').classList.remove('hidden');
    };

    const closeBtn = document.getElementById('closeGraficaSettingsBtn');
    const cancelBtn = document.getElementById('cancelGraficaSettingsBtn');
    const closeModal = () => document.getElementById('graficaSettingsModal').classList.add('hidden');
    if (closeBtn) closeBtn.onclick = closeModal;
    if (cancelBtn) cancelBtn.onclick = closeModal;

    document.getElementById('graficaSettingsForm').onsubmit = (e) => {
        e.preventDefault();
        graficaSettings.backupEmail = document.getElementById('gBackupEmail').value.trim();
        graficaSettings.emailjsServiceId = document.getElementById('gEmailjsServiceId').value.trim();
        graficaSettings.emailjsTemplateId = document.getElementById('gEmailjsTemplateId').value.trim();
        graficaSettings.emailjsPublicKey = document.getElementById('gEmailjsPublicKey').value.trim();
        saveGraficaSettings();
        showToast('Configurações da Gráfica salvas!', 'success');
        closeModal();
    };
}

// ----- Renderers -----
function renderGraficaApp() {
    populateGraficaMonthFilter();
    renderCategoryGrid();
    renderGraficaCart();
    renderGraficaVendasTable();
    renderGraficaProdutosTable();
    renderGraficaDespesasOpTable();
    renderGraficaDRE();
    renderGraficaDespesasPessoaisTable();
    
    // Novo Catalogo Dinâmico
    renderCatalogMatrix();
    renderCatalogUnidade();
    renderCatalogM2();
    
    updateGraficaKpis();
}

function populateVendaBalcaoProdutosDropdown() {
    const select = document.getElementById('bPadronizadoSelect');
    if (!select) return;
    const currentVal = select.value;
    select.innerHTML = '<option value="">-- Selecione do Catálogo --</option>' +
        graficaProdutos.map(p => `<option value="${p.id}">${p.nome} (${p.medidas || 'Padronizado'}) - R$ ${p.precoVenda.toFixed(2)} [Estoque: ${p.qtdEstoque}]</option>`).join('');
    if (currentVal) select.value = currentVal;
}

function renderGraficaVendasTable() {
    const tbody = document.getElementById('graficaVendasTableBody');
    if (!tbody) return;
    const m = document.getElementById('graficaMonthFilter').value;
    const filtered = graficaVendas.filter(e => monthKey(e.data) === m);

    if (!filtered.length) {
        tbody.innerHTML = emptyRow(10, 'Nenhum pedido ou venda no período.');
        return;
    }

    tbody.innerHTML = filtered.map(v => {
        const st = v.status || 'Entregue';
        const stColor = st === 'Pendente Aprovação' ? 'badge-warning' : (st === 'Pendente Entrega' ? 'badge-info' : 'badge-success');
        
        return `
        <tr>
            <td>${dateBR(v.data)}</td>
            <td><strong>${v.cliente || 'Balcão'}</strong></td>
            <td><span class="badge ${v.tipoItem.includes('Produto') ? 'badge-success' : 'badge-primary'}">${v.tipoItem}</span></td>
            <td>${v.detalhes} | <strong>Qtd: ${v.qtd}</strong>${v.m2Total ? ` (${v.m2Total.toFixed(2)} m²)` : ''}</td>
            <td>${fmtR(v.custoTotal)}</td>
            <td><strong>${fmtR(v.precoTotal)}</strong></td>
            <td class="text-success"><strong>+${fmtR(v.lucro)}</strong></td>
            <td><span class="badge badge-secondary">${v.formaPagamento || 'PIX'}</span></td>
            <td>
                <select class="form-control" style="width:auto; display:inline-block;" onchange="changeGraficaVendaStatus('${v.id}', this.value)">
                    <option value="Pendente Aprovação" ${st === 'Pendente Aprovação' ? 'selected' : ''}>🟡 Pendente Aprovação</option>
                    <option value="Pendente Entrega" ${st === 'Pendente Entrega' ? 'selected' : ''}>🟠 Pendente Entrega</option>
                    <option value="Entregue" ${st === 'Entregue' ? 'selected' : ''}>🟢 Entregue</option>
                </select>
            </td>
            <td>
                <button class="action-btn action-delete" onclick="deleteGraficaVenda('${v.id}')" title="Excluir Venda"><i class="fa-solid fa-trash"></i></button>
            </td>
        </tr>
    `}).join('');
}

window.changeGraficaVendaStatus = function(id, newStatus) {
    const v = graficaVendas.find(x => x.id === id);
    if (v) {
        v.status = newStatus;
        saveGraficaVendas();
        showToast('Status do pedido atualizado!', 'success');
        renderGraficaVendasTable();
    }
};

function renderGraficaProdutosTable() {
    const tbody = document.getElementById('graficaProdutosTableBody');
    if (!tbody) return;

    if (!graficaProdutos.length) {
        tbody.innerHTML = emptyRow(9, 'Nenhum produto cadastrado no catálogo.');
        return;
    }

    tbody.innerHTML = graficaProdutos.map(p => {
        const isLow = p.qtdEstoque <= (p.estoqueMinimo || 5);
        return `
            <tr>
                <td><strong>${p.nome}</strong></td>
                <td>${p.categoria}</td>
                <td>${fmtR(p.custoUnitario)}</td>
                <td><strong>${fmtR(p.precoVenda)}</strong></td>
                <td>${p.margemLucro.toFixed(1)}%</td>
                <td><strong>${p.qtdEstoque} un</strong></td>
                <td>
                    <span class="badge ${isLow ? 'badge-low-stock' : 'badge-ok-stock'}">
                        ${isLow ? `🚨 Estoque Mínimo (${p.qtdEstoque})` : '✅ Normal'}
                    </span>
                </td>
                <td>
                    <button class="action-btn action-edit" onclick="editGraficaProduto('${p.id}')" title="Editar"><i class="fa-solid fa-pen"></i></button>
                    <button class="action-btn action-delete" onclick="deleteGraficaProduto('${p.id}')" title="Excluir"><i class="fa-solid fa-trash"></i></button>
                </td>
            </tr>
        `;
    }).join('');
}

function renderGraficaDespesasOpTable() {
    const tbody = document.getElementById('graficaDespesasOpTableBody');
    if (!tbody) return;
    const m = document.getElementById('graficaMonthFilter').value;
    const filtered = graficaDespesasOp.filter(e => monthKey(e.data) === m);

    if (!filtered.length) {
        tbody.innerHTML = emptyRow(6, 'Nenhuma despesa operacional registrada no período.');
        return;
    }

    tbody.innerHTML = filtered.map(d => `
        <tr>
            <td>${dateBR(d.data)}</td>
            <td><span class="badge badge-secondary">${d.categoria}</span></td>
            <td><strong>${d.descricao}</strong></td>
            <td class="text-danger"><strong>${fmtR(d.valor)}</strong></td>
            <td>
                <span class="badge ${d.status === 'Pago' ? 'badge-success' : 'badge-danger'}">${d.status}</span>
            </td>
            <td>
                <button class="action-btn action-edit" onclick="editGraficaDespesaOp('${d.id}')" title="Editar"><i class="fa-solid fa-pen"></i></button>
                <button class="action-btn action-delete" onclick="deleteGraficaDespesaOp('${d.id}')" title="Excluir"><i class="fa-solid fa-trash"></i></button>
            </td>
        </tr>
    `).join('');
}

function renderGraficaDRE() {
    const m = document.getElementById('graficaMonthFilter').value;

    const vendasMes = graficaVendas.filter(e => monthKey(e.data) === m);
    const despesasOpMes = graficaDespesasOp.filter(e => monthKey(e.data) === m);
    const despesasPessoaisMes = graficaDespesasPessoais.filter(e => monthKey(e.vencimento) === m);

    const receitaBruta = vendasMes.reduce((acc, v) => acc + (v.precoTotal || 0), 0);
    const cmv = vendasMes.reduce((acc, v) => acc + (v.custoTotal || 0), 0);
    const lucroBruto = receitaBruta - cmv;
    const margemBruta = receitaBruta > 0 ? (lucroBruto / receitaBruta) * 100 : 0;

    const despesasOp = despesasOpMes.reduce((acc, d) => acc + (d.valor || 0), 0);
    const lucroLiquido = lucroBruto - despesasOp;
    const margemLiquida = receitaBruta > 0 ? (lucroLiquido / receitaBruta) * 100 : 0;

    const retiradasPessoais = despesasPessoaisMes.reduce((acc, d) => acc + (d.valor || 0), 0);
    const saldoFinal = lucroLiquido - retiradasPessoais;

    document.getElementById('dreReceitaBruta').textContent = fmtR(receitaBruta);
    document.getElementById('dreCmv').textContent = fmtR(cmv);
    document.getElementById('dreLucroBruto').textContent = fmtR(lucroBruto);
    document.getElementById('dreMargemBruta').textContent = `${margemBruta.toFixed(1)}%`;
    document.getElementById('dreDespesasOp').textContent = fmtR(despesasOp);

    const elLiquido = document.getElementById('dreLucroLiquido');
    elLiquido.textContent = fmtR(lucroLiquido);
    elLiquido.className = lucroLiquido >= 0 ? 'text-success fs-1-2' : 'text-danger fs-1-2';

    document.getElementById('dreMargemLiquida').textContent = `${margemLiquida.toFixed(1)}%`;
    document.getElementById('dreRetiradasPessoais').textContent = fmtR(retiradasPessoais);

    const elSaldo = document.getElementById('dreSaldoFinal');
    elSaldo.textContent = fmtR(saldoFinal);
    elSaldo.className = saldoFinal >= 0 ? 'text-success fs-1-2' : 'text-danger fs-1-2';
}

function renderGraficaDespesasPessoaisTable() {
    const tbody = document.getElementById('graficaPessoalTableBody');
    if (!tbody) return;
    const m = document.getElementById('graficaMonthFilter').value;
    const filtered = graficaDespesasPessoais.filter(e => monthKey(e.vencimento) === m);

    if (!filtered.length) {
        tbody.innerHTML = emptyRow(7, 'Nenhuma despesa pessoal / doméstica registrada no período.');
        return;
    }

    tbody.innerHTML = filtered.map(d => `
        <tr>
            <td>${dateBR(d.vencimento)}</td>
            <td>${d.pagamento ? dateBR(d.pagamento) : '-'}</td>
            <td><span class="badge badge-secondary">${d.categoria}</span></td>
            <td><strong>${d.descricao}</strong></td>
            <td class="text-danger"><strong>${fmtR(d.valor)}</strong></td>
            <td>
                <span class="badge ${d.status === 'Pago' ? 'badge-success' : 'badge-danger'}">${d.status}</span>
            </td>
            <td>
                <button class="action-btn action-edit" onclick="editGraficaDespesaPessoal('${d.id}')" title="Editar"><i class="fa-solid fa-pen"></i></button>
                <button class="action-btn action-delete" onclick="deleteGraficaDespesaPessoal('${d.id}')" title="Excluir"><i class="fa-solid fa-trash"></i></button>
            </td>
        </tr>
    `).join('');
}

function updateGraficaKpis() {
    const m = document.getElementById('graficaMonthFilter').value;

    // Tab Produtos KPIs
    document.getElementById('kpiGraficaTotalProdutos').textContent = graficaProdutos.length;
    document.getElementById('kpiGraficaTiposCount').textContent = `${graficaProdutos.length} itens no catálogo`;

    const alertasCount = graficaProdutos.filter(p => p.qtdEstoque <= (p.estoqueMinimo || 5)).length;
    document.getElementById('kpiGraficaAlertasEstoque').textContent = alertasCount;

    const custoEstoqueTotal = graficaProdutos.reduce((acc, p) => acc + (p.custoUnitario * p.qtdEstoque), 0);
    const vendaEstoqueTotal = graficaProdutos.reduce((acc, p) => acc + (p.precoVenda * p.qtdEstoque), 0);
    document.getElementById('kpiGraficaEstoqueCusto').textContent = fmtR(custoEstoqueTotal);
    document.getElementById('kpiGraficaEstoqueVenda').textContent = `Potencial Venda: ${fmtR(vendaEstoqueTotal)}`;

    // Tab Despesas Op KPIs
    const despesasOpMes = graficaDespesasOp.filter(e => monthKey(e.data) === m);
    const totalOp = despesasOpMes.reduce((acc, d) => acc + d.valor, 0);
    const pagasOp = despesasOpMes.filter(d => d.status === 'Pago').reduce((acc, d) => acc + d.valor, 0);
    const pendentesOp = despesasOpMes.filter(d => d.status === 'Pendente').reduce((acc, d) => acc + d.valor, 0);

    document.getElementById('kpiGraficaDespesasOpTotal').textContent = fmtR(totalOp);
    document.getElementById('kpiGraficaDespesasOpCount').textContent = `${despesasOpMes.length} registros em ${m}`;
    document.getElementById('kpiGraficaDespesasOpPagas').textContent = fmtR(pagasOp);
    document.getElementById('kpiGraficaDespesasOpPendentes').textContent = fmtR(pendentesOp);

    // Tab Pessoal KPIs
    const despesasPessoaisMes = graficaDespesasPessoais.filter(e => monthKey(e.vencimento) === m);
    const totalPess = despesasPessoaisMes.reduce((acc, d) => acc + d.valor, 0);
    const pagasPess = despesasPessoaisMes.filter(d => d.status === 'Pago').reduce((acc, d) => acc + d.valor, 0);
    const pendentesPess = despesasPessoaisMes.filter(d => d.status === 'Pendente').reduce((acc, d) => acc + d.valor, 0);

    document.getElementById('kpiGraficaPessoalTotal').textContent = fmtR(totalPess);
    document.getElementById('kpiGraficaPessoalPagas').textContent = fmtR(pagasPess);
    document.getElementById('kpiGraficaPessoalPendentes').textContent = fmtR(pendentesPess);
}

// ----- Deletes & Edits -----
window.deleteGraficaVenda = function(id) {
    if (!confirm('Excluir este registro de venda?')) return;
    graficaVendas = graficaVendas.filter(v => v.id !== id);
    deleteCloudItem('grafica_vendas', id);
    saveGraficaVendas();
    renderGraficaApp();
};

window.deleteGraficaProduto = function(id) {
    if (!confirm('Excluir este produto do catálogo?')) return;
    graficaProdutos = graficaProdutos.filter(p => p.id !== id);
    deleteCloudItem('grafica_produtos', id);
    saveGraficaProdutos();
    renderGraficaApp();
};

window.editGraficaProduto = function(id) {
    const prod = graficaProdutos.find(p => p.id === id);
    if (!prod) return;
    editingGraficaProdutoId = id;
    document.getElementById('graficaProdutoId').value = prod.id;
    document.getElementById('graficaProdutoNome').value = prod.nome;
    document.getElementById('graficaProdutoCategoria').value = prod.categoria;
    document.getElementById('graficaProdutoCusto').value = prod.custoUnitario;
    document.getElementById('graficaProdutoMargem').value = prod.margemLucro;
    document.getElementById('graficaProdutoPreco').value = prod.precoVenda;
    document.getElementById('graficaProdutoEstoque').value = prod.qtdEstoque;
    document.getElementById('graficaProdutoEstoqueMin').value = prod.estoqueMinimo || 5;

    document.getElementById('graficaProdutoFormWrapper').classList.remove('hidden');
};

window.deleteGraficaDespesaOp = function(id) {
    if (!confirm('Excluir esta despesa operacional?')) return;
    graficaDespesasOp = graficaDespesasOp.filter(d => d.id !== id);
    deleteCloudItem('grafica_despesas_op', id);
    saveGraficaDespesasOp();
    renderGraficaApp();
};

window.editGraficaDespesaOp = function(id) {
    const d = graficaDespesasOp.find(item => item.id === id);
    if (!d) return;
    editingGraficaDespesaOpId = id;
    document.getElementById('graficaDespesaOpId').value = d.id;
    document.getElementById('graficaDespesaOpData').value = d.data;
    document.getElementById('graficaDespesaOpCategoria').value = d.categoria;
    document.getElementById('graficaDespesaOpDescricao').value = d.descricao;
    document.getElementById('graficaDespesaOpValor').value = d.valor;
    document.getElementById('graficaDespesaOpStatus').value = d.status;

    document.getElementById('graficaDespesaOpFormWrapper').classList.remove('hidden');
};

window.deleteGraficaDespesaPessoal = function(id) {
    if (!confirm('Excluir esta despesa pessoal?')) return;
    graficaDespesasPessoais = graficaDespesasPessoais.filter(d => d.id !== id);
    deleteCloudItem('grafica_despesas_pessoais', id);
    saveGraficaDespesasPessoais();
    renderGraficaApp();
};

window.editGraficaDespesaPessoal = function(id) {
    const d = graficaDespesasPessoais.find(item => item.id === id);
    if (!d) return;
    editingGraficaDespesaPessoalId = id;
    document.getElementById('graficaPessoalId').value = d.id;
    document.getElementById('graficaPessoalVencimento').value = d.vencimento;
    document.getElementById('graficaPessoalPagamento').value = d.pagamento || '';
    document.getElementById('graficaPessoalCategoria').value = d.categoria;
    document.getElementById('graficaPessoalDescricao').value = d.descricao;
    document.getElementById('graficaPessoalValor').value = d.valor;
    document.getElementById('graficaPessoalStatus').value = d.status;

    document.getElementById('graficaPessoalFormWrapper').classList.remove('hidden');
};

function exportGraficaCsv() {
    const m = document.getElementById('graficaMonthFilter').value;
    const vendas = graficaVendas.filter(e => monthKey(e.data) === m);

    let csv = 'Data;Cliente;TipoItem;Detalhes;Quantidade;CustoTotal;PrecoTotal;Lucro;FormaPagamento;Observacoes\n';
    vendas.forEach(v => {
        csv += `"${v.data}";"${v.cliente || ''}";"${v.tipoItem}";"${v.detalhes}";${v.qtd};${v.custoTotal.toFixed(2)};${v.precoTotal.toFixed(2)};${v.lucro.toFixed(2)};"${v.formaPagamento}";"${v.obs || ''}"\n`;
    });

    downloadCSV(csv, `relatorio_grafica_${m}.csv`);
    showToast('Relatório CSV exportado!', 'success');
}

// ==========================================
// CATÁLOGO DINÂMICO & PRECIFICAÇÃO
// ==========================================

function getPriceFor(key, defaultPrice) {
    if (graficaPrices[key] !== undefined) {
        return graficaPrices[key];
    }
    return defaultPrice;
}

window.onPriceChange = function(key, el) {
    const val = parseFloat(el.value);
    if (!isNaN(val)) {
        graficaPrices[key] = val;
    } else {
        delete graficaPrices[key];
    }
}

window.resetPricesToDefault = function() {
    if (confirm('Tem certeza que deseja apagar todos os preços personalizados e voltar às fórmulas automáticas padrão?')) {
        graficaPrices = {};
        saveGraficaPrices();
        renderCatalogMatrix();
        renderCatalogUnidade();
        renderCatalogM2();
    }
}

window.switchCatalogTab = function(tabName) {
    document.getElementById('catalogTabMatriz').classList.add('hidden');
    document.getElementById('catalogTabUnidade').classList.add('hidden');
    document.getElementById('catalogTabM2').classList.add('hidden');
    
    const btns = ['btnTabMatriz', 'btnTabUnidade', 'btnTabM2'];
    btns.forEach(b => {
        const el = document.getElementById(b);
        if(el) {
            el.classList.remove('border-brand-500', 'text-brand-400');
            el.classList.add('border-transparent', 'text-slate-400');
        }
    });

    if (tabName === 'matriz') {
        document.getElementById('catalogTabMatriz').classList.remove('hidden');
        document.getElementById('btnTabMatriz').classList.add('border-brand-500', 'text-brand-400');
        renderCatalogMatrix();
    } else if (tabName === 'unidade') {
        document.getElementById('catalogTabUnidade').classList.remove('hidden');
        document.getElementById('btnTabUnidade').classList.add('border-brand-500', 'text-brand-400');
        renderCatalogUnidade();
    } else if (tabName === 'm2') {
        document.getElementById('catalogTabM2').classList.remove('hidden');
        document.getElementById('btnTabM2').classList.add('border-brand-500', 'text-brand-400');
        renderCatalogM2();
    }
}

window.renderCatalogMatrix = function() {
    const tbody = document.getElementById('catalogMatrixBody');
    if (!tbody) return;
    
    const prodKey = document.getElementById('catalogFilterProd').value;
    const prod = pdvCatalog.find(p => p.id === prodKey);
    
    if (!prod || prod.group !== 'A') {
        tbody.innerHTML = `<tr><td colspan="5" class="p-4 text-center text-slate-500">Produto não aplicável a matriz de tiragens.</td></tr>`;
        return;
    }

    let html = '';
    
    prod.tamanhos.forEach(tamanho => {
        const tBase = prod.baseTamanhos[tamanho];
        prod.papeis.forEach(papel => {
            prod.cores.forEach(cor => {
                const cBase = prod.baseCores[cor];
                prod.tiragens.forEach(tiragem => {
                    const defaultPrice = tBase * cBase * prod.tiragemBase[tiragem];
                    const key = `${prod.id}_${tamanho}_${papel}_${cor}_${tiragem}`;
                    const currentPrice = getPriceFor(key, defaultPrice);
                    
                    html += `
                        <tr class="hover:bg-slate-800 transition">
                            <td class="p-3 text-slate-300">${tamanho}</td>
                            <td class="p-3 text-slate-300">${papel}</td>
                            <td class="p-3 text-slate-300">${cor}</td>
                            <td class="p-3 text-slate-300 font-medium">${tiragem.toLocaleString('pt-BR')} un</td>
                            <td class="p-3 text-right">
                                <div class="flex justify-end items-center">
                                    <span class="text-slate-500 mr-2">R$</span>
                                    <input type="number" step="0.01" value="${currentPrice.toFixed(2)}" 
                                           onchange="onPriceChange('${key}', this)"
                                           class="w-24 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-white text-right focus:border-brand-500 focus:outline-none">
                                </div>
                            </td>
                        </tr>
                    `;
                });
            });
        });
    });
    
    tbody.innerHTML = html;
}

window.renderCatalogUnidade = function() {
    const tbody = document.getElementById('catalogUnidadeBody');
    if (!tbody) return;
    
    const prods = pdvCatalog.filter(p => p.group === 'B');
    let html = '';
    
    prods.forEach(prod => {
        prod.tamanhos.forEach(tamanho => {
            prod.papeis.forEach(papel => {
                prod.cores.forEach(cor => {
                    const cBase = prod.baseCores ? prod.baseCores[cor] : 1;
                    const pBase = prod.basePrecoUnidade || 1;
                    const defaultPrice = cBase * pBase;
                    
                    const key = `${prod.id}_${tamanho}_${papel}_${cor}`;
                    const currentPrice = getPriceFor(key, defaultPrice);
                    
                    html += `
                        <tr class="hover:bg-slate-800 transition">
                            <td class="p-3 font-medium text-brand-400">${prod.nome}</td>
                            <td class="p-3 text-slate-300">${papel} - ${tamanho}</td>
                            <td class="p-3 text-slate-300">${cor}</td>
                            <td class="p-3 text-right">
                                <div class="flex justify-end items-center">
                                    <span class="text-slate-500 mr-2">R$</span>
                                    <input type="number" step="0.01" value="${currentPrice.toFixed(2)}" 
                                           onchange="onPriceChange('${key}', this)"
                                           class="w-24 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-white text-right focus:border-brand-500 focus:outline-none">
                                </div>
                            </td>
                        </tr>
                    `;
                });
            });
        });
    });
    tbody.innerHTML = html;
}

window.renderCatalogM2 = function() {
    const tbody = document.getElementById('catalogM2Body');
    if (!tbody) return;
    
    const prods = pdvCatalog.filter(p => p.group === 'C');
    let html = '';
    
    prods.forEach(prod => {
        prod.papeis.forEach(papel => {
            const defaultPrice = prod.precoM2 || 45;
            const key = `${prod.id}_${papel}`;
            const currentPrice = getPriceFor(key, defaultPrice);
            
            html += `
                <tr class="hover:bg-slate-800 transition">
                    <td class="p-3 font-medium text-brand-400">${papel}</td>
                    <td class="p-3 text-slate-300">${prod.nome}</td>
                    <td class="p-3 text-right">
                        <div class="flex justify-end items-center">
                            <span class="text-slate-500 mr-2">R$</span>
                            <input type="number" step="0.01" value="${currentPrice.toFixed(2)}" 
                                   onchange="onPriceChange('${key}', this)"
                                   class="w-24 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-white text-right focus:border-brand-500 focus:outline-none">
                        </div>
                    </td>
                </tr>
            `;
        });
    });
    tbody.innerHTML = html;
}
