// =====================================================
// STATE
// =====================================================
let usersList = [];
let currentUser = null;
let authToken = localStorage.getItem('uber_finance_auth_token') || null;

async function setCurrentUser(userObj) {
    currentUser = userObj;
    if (supabaseClient && currentUser) {
        try {
            const { data: { user } } = await supabaseClient.auth.getUser();
            if (user) currentUser.supabaseUserId = user.id;
        } catch(e) {}
    }
    localStorage.setItem('uber_finance_logged_user', JSON.stringify(currentUser));
}

// =====================================================
// SUPABASE CLIENT INIT
// =====================================================
let SUPABASE_URL = localStorage.getItem('supabase_url') || 'https://fogmkzbiyukyvbidwuuo.supabase.co';
let SUPABASE_KEY = localStorage.getItem('supabase_anon_key') || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZvZ21remJpeXVreXZiaWR3dXVvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ4MTc0NTAsImV4cCI6MjEwMDM5MzQ1MH0.WE3FzYhgVk9Jm3EzKLP5Drw2WBl176VVk1rSu5KERFI';
let supabaseClient = null;

if (SUPABASE_URL && SUPABASE_KEY && window.supabase) {
    supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
}

// =====================================================
// ID GENERATION — UUID v4 (globalmente único, sem colisões)
// Substitui Date.now() que causava colisão entre dispositivos.
// crypto.randomUUID() é suportado em Electron, Chrome 92+,
// Firefox 95+, Safari 15.4+.
// =====================================================
function generateId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return crypto.randomUUID();
    }
    // Fallback para ambientes muito antigos (não deveria ocorrer)
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
}

// =====================================================
// SYNC ENGINE — Motor de sincronização robusto
// Gerencia: retry, backoff, fila de pendentes, sync
// incremental, prevenção de loop, resolução de conflitos.
// =====================================================
const SyncEngine = {
    // Versão incremental do flag de self-sync (substitui o isSelfSync fixo)
    // Cada operação recebe uma versão única; eventos Realtime com versão
    // menor ou igual à atual são descartados, evitando loops mesmo se a
    // conexão for lenta.
    syncVersion: 0,
    activeSyncVersion: 0,

    // Timestamp da última sincronização bem-sucedida — usado para
    // carregar apenas registros modificados depois desse momento.
    lastSyncAt: null,

    // Chave localStorage para a fila persistida de pendentes
    queueKey() {
        return currentUser ? `sync_pending_v2_${currentUser.username}` : 'sync_pending_v2_guest';
    },

    // ─── UTILITÁRIO: Retry com backoff exponencial ───────────────────
    // Tenta fn() até maxAttempts vezes, aguardando 2^n * 1000ms entre
    // tentativas, com teto em 30s. Só faz retry em erros de rede/5xx;
    // erros de negócio (4xx) são propagados imediatamente.
    async withRetry(fn, maxAttempts = 4, context = '') {
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                return await fn();
            } catch (err) {
                const isRetryable = !navigator.onLine
                    || (err.status >= 500 && err.status < 600)
                    || err.message?.toLowerCase().includes('fetch')
                    || err.message?.toLowerCase().includes('network')
                    || err.message?.toLowerCase().includes('timeout');

                if (!isRetryable || attempt === maxAttempts) throw err;

                const delayMs = Math.min(1000 * Math.pow(2, attempt), 30000);
                console.warn(`[SyncEngine] ${context} — tentativa ${attempt}/${maxAttempts}. Retry em ${delayMs}ms. Erro: ${err.message}`);
                await new Promise(r => setTimeout(r, delayMs));
            }
        }
    },

    // ─── FILA LOCAL DE PENDENTES (Dead Letter Queue) ─────────────────
    // Cada operação é enfileirada antes de ser enviada ao Supabase.
    // Se o envio falhar, fica na fila para reprocessamento automático.
    // A fila é persistida no localStorage para sobreviver a recargas.

    getQueue() {
        try {
            return JSON.parse(localStorage.getItem(this.queueKey()) || '[]');
        } catch { return []; }
    },

    saveQueue(queue) {
        try {
            localStorage.setItem(this.queueKey(), JSON.stringify(queue));
        } catch (e) {
            console.warn('[SyncEngine] Erro ao salvar fila:', e);
        }
    },

    // Enfileira uma operação individual.
    // Remove entrada anterior para o mesmo registro (idempotência):
    // apenas a versão mais recente de uma operação importa.
    enqueue(table, recordId, operation, payload) {
        const queue = this.getQueue();
        const filtered = queue.filter(q => !(q.table === table && q.recordId === recordId));
        filtered.push({
            table, recordId, operation, payload,
            attempts: 0, isDead: false,
            createdAt: new Date().toISOString()
        });
        this.saveQueue(filtered);
    },

    // Processa toda a fila de pendentes, com retry por item.
    // Uma falha num item não interrompe os demais.
    async processQueue() {
        if (!supabaseClient || !currentUser) return;
        const queue = this.getQueue();
        if (!queue.length) return;

        const failed = [];
        for (const item of queue) {
            if (item.isDead) { failed.push(item); continue; }
            try {
                if (item.operation === 'UPSERT') {
                    const res = await this.withRetry(
                        () => supabaseClient.from(item.table).upsert(item.payload, { onConflict: 'id' }),
                        4, `processQueue UPSERT ${item.table}/${item.recordId}`
                    );
                    if (res?.error) throw new Error(res.error.message);
                } else if (item.operation === 'DELETE') {
                    const res = await this.withRetry(
                        () => supabaseClient.from(item.table).delete().eq('id', item.recordId),
                        4, `processQueue DELETE ${item.table}/${item.recordId}`
                    );
                    if (res?.error) throw new Error(res.error.message);
                }
                // Sucesso — não adiciona de volta na fila
                this._logAudit(item.table, item.recordId, 'SYNC_SUCCESS');
            } catch (err) {
                item.attempts = (item.attempts || 0) + 1;
                this._logAudit(item.table, item.recordId, 'SYNC_FAILED', err.message);
                if (item.attempts >= 5) {
                    item.isDead = true;
                    console.error(`[SyncEngine] Dead letter: ${item.table}/${item.recordId} após ${item.attempts} tentativas.`, err.message);
                }
                failed.push(item);
            }
        }
        this.saveQueue(failed);

        // Exibe alerta se houver itens mortos (DLQ)
        const deadCount = failed.filter(q => q.isDead).length;
        if (deadCount > 0) {
            showToast(`⚠️ ${deadCount} registro(s) com falha permanente de sync. Verifique em Configurações > Status de Sync.`, 'warning');
        }
    },

    // ─── SINCRONIZAÇÃO INCREMENTAL — CARGA ───────────────────────────
    // Baixa apenas registros modificados APÓS lastSyncAt.
    // Na primeira carga (lastSyncAt = null), baixa tudo normalmente.
    // Faz merge cirúrgico no array em memória em vez de substituição total.

    async loadIncremental() {
        if (!supabaseClient || !currentUser) return;
        try {
            const { data: { user } } = await supabaseClient.auth.getUser();
            if (!user) return;

            const since = this.lastSyncAt;

            if (currentUser.accountType === 'uber') {
                const [uRes, pRes, sRes] = await Promise.all([
                    since
                        ? supabaseClient.from('uber_entries').select('*').gt('updated_at', since)
                        : supabaseClient.from('uber_entries').select('*'),
                    since
                        ? supabaseClient.from('personal_entries').select('*').gt('updated_at', since)
                        : supabaseClient.from('personal_entries').select('*'),
                    supabaseClient.from('user_settings').select('settings_json').single()
                ]);

                if (uRes.data?.length) {
                    uRes.data.forEach(r => {
                        const mapped = { id: r.id, date: r.date, gross: r.gross, fuel: r.fuel, other: r.other, otherDesc: r.other_desc, km: r.km };
                        const idx = uberEntries.findIndex(e => e.id === r.id);
                        if (idx === -1) uberEntries.push(mapped); else uberEntries[idx] = mapped;
                    });
                    localStorage.setItem(userKey('uber_finance_entries'), JSON.stringify(uberEntries));
                }
                if (pRes.data?.length) {
                    pRes.data.forEach(r => {
                        const mapped = { id: r.id, date: r.date, category: r.category, value: r.value, status: r.status, desc: r.description };
                        const idx = personalEntries.findIndex(e => e.id === r.id);
                        if (idx === -1) personalEntries.push(mapped); else personalEntries[idx] = mapped;
                    });
                    localStorage.setItem(userKey('uber_finance_personal_entries'), JSON.stringify(personalEntries));
                }
                if (!since && sRes.data?.settings_json) {
                    uberSettings = { ...uberSettings, ...sRes.data.settings_json };
                    localStorage.setItem(userKey('uber_finance_settings'), JSON.stringify(uberSettings));
                }

            } else if (currentUser.accountType === 'roupas') {
                const [estRes, compRes, vndRes, sRes] = await Promise.all([
                    since ? supabaseClient.from('estoque_items').select('*').gt('updated_at', since) : supabaseClient.from('estoque_items').select('*'),
                    since ? supabaseClient.from('compras_entries').select('*').gt('updated_at', since) : supabaseClient.from('compras_entries').select('*'),
                    since ? supabaseClient.from('vendas_entries').select('*').gt('updated_at', since) : supabaseClient.from('vendas_entries').select('*'),
                    supabaseClient.from('user_settings').select('settings_json').single()
                ]);

                if (estRes.data?.length) {
                    estRes.data.forEach(r => {
                        const mapped = { id: r.id, nome: r.nome, categoria: r.categoria, tamanho: r.tamanho, qtd: r.qtd, custo: r.custo, precoVenda: r.preco_venda, dataEntrada: r.data_entrada };
                        const idx = estoqueItems.findIndex(e => e.id === r.id);
                        if (idx === -1) estoqueItems.push(mapped); else estoqueItems[idx] = mapped;
                    });
                    localStorage.setItem(userKey('roupas_estoque'), JSON.stringify(estoqueItems));
                }
                if (compRes.data?.length) {
                    compRes.data.forEach(r => {
                        const mapped = { id: r.id, data: r.date, produto: r.produto, qtd: r.qtd, custo: r.custo, transporte: r.transporte, fornecedor: r.fornecedor };
                        const idx = comprasEntries.findIndex(e => e.id === r.id);
                        if (idx === -1) comprasEntries.push(mapped); else comprasEntries[idx] = mapped;
                    });
                    localStorage.setItem(userKey('roupas_compras'), JSON.stringify(comprasEntries));
                }
                if (vndRes.data?.length) {
                    vndRes.data.forEach(r => {
                        const mapped = { id: r.id, data: r.date, stockItemId: r.stock_item_id, produto: r.produto, tamanho: r.tamanho, qtd: r.qtd, valor: r.valor, custoRef: r.custo_ref, lucro: r.lucro, obs: r.obs };
                        const idx = vendasEntries.findIndex(e => e.id === r.id);
                        if (idx === -1) vendasEntries.push(mapped); else vendasEntries[idx] = mapped;
                    });
                    localStorage.setItem(userKey('roupas_vendas'), JSON.stringify(vendasEntries));
                }
                if (!since && sRes.data?.settings_json) {
                    roupasSettings = { ...roupasSettings, ...sRes.data.settings_json };
                    localStorage.setItem(userKey('roupas_finance_settings'), JSON.stringify(roupasSettings));
                }

            } else if (currentUser.accountType === 'grafica') {
                const [prodsRes, vndsRes, despsOpRes, despsPessRes, sRes] = await Promise.all([
                    since ? supabaseClient.from('grafica_produtos').select('*').gt('updated_at', since) : supabaseClient.from('grafica_produtos').select('*'),
                    since ? supabaseClient.from('grafica_vendas').select('*').gt('updated_at', since) : supabaseClient.from('grafica_vendas').select('*'),
                    since ? supabaseClient.from('grafica_despesas_op').select('*').gt('updated_at', since) : supabaseClient.from('grafica_despesas_op').select('*'),
                    since ? supabaseClient.from('grafica_despesas_pessoais').select('*').gt('updated_at', since) : supabaseClient.from('grafica_despesas_pessoais').select('*'),
                    supabaseClient.from('user_settings').select('settings_json').single()
                ]);

                if (prodsRes.data?.length) {
                    prodsRes.data.forEach(r => {
                        const mapped = { id: r.id, tipo: r.tipo, nome: r.nome, categoria: r.categoria, medidas: r.medidas, tipoPapel: r.tipo_papel, acabamento: r.acabamento, custoUnitario: r.custo_unitario, margemLucro: r.margem_lucro, precoVenda: r.preco_venda, qtdEstoque: r.qtd_estoque, estoqueMinimo: r.estoque_minimo };
                        const idx = graficaProdutos.findIndex(e => e.id === r.id);
                        if (idx === -1) graficaProdutos.push(mapped); else graficaProdutos[idx] = mapped;
                    });
                    localStorage.setItem(userKey('grafica_produtos'), JSON.stringify(graficaProdutos));
                }
                if (vndsRes.data?.length) {
                    vndsRes.data.forEach(r => {
                        const mapped = { id: r.id, data: r.date, cliente: r.cliente, tipoItem: r.tipo_item, produtoId: r.produto_id, detalhes: r.detalhes, larguraCm: r.largura_cm, alturaCm: r.altura_cm, m2Total: r.m2_total, qtd: r.qtd, custoTotal: r.custo_total, precoTotal: r.preco_total, lucro: r.lucro, formaPagamento: r.forma_pagamento, obs: r.obs };
                        const idx = graficaVendas.findIndex(e => e.id === r.id);
                        if (idx === -1) graficaVendas.push(mapped); else graficaVendas[idx] = mapped;
                    });
                    localStorage.setItem(userKey('grafica_vendas'), JSON.stringify(graficaVendas));
                }
                if (despsOpRes.data?.length) {
                    despsOpRes.data.forEach(r => {
                        const mapped = { id: r.id, data: r.date, categoria: r.categoria, descricao: r.descricao, valor: r.valor, status: r.status };
                        const idx = graficaDespesasOp.findIndex(e => e.id === r.id);
                        if (idx === -1) graficaDespesasOp.push(mapped); else graficaDespesasOp[idx] = mapped;
                    });
                    localStorage.setItem(userKey('grafica_despesas_op'), JSON.stringify(graficaDespesasOp));
                }
                if (despsPessRes.data?.length) {
                    despsPessRes.data.forEach(r => {
                        const mapped = { id: r.id, vencimento: r.vencimento, pagamento: r.pagamento, categoria: r.categoria, valor: r.valor, status: r.status, descricao: r.descricao };
                        const idx = graficaDespesasPessoais.findIndex(e => e.id === r.id);
                        if (idx === -1) graficaDespesasPessoais.push(mapped); else graficaDespesasPessoais[idx] = mapped;
                    });
                    localStorage.setItem(userKey('grafica_despesas_pessoais'), JSON.stringify(graficaDespesasPessoais));
                }
                if (!since && sRes.data?.settings_json) {
                    graficaSettings = { ...graficaSettings, ...sRes.data.settings_json };
                    localStorage.setItem(userKey('grafica_settings'), JSON.stringify(graficaSettings));
                }

            } else if (currentUser.accountType === 'casa') {
                const [rRes, dRes, sRes, stRes] = await Promise.all([
                    since ? supabaseClient.from('casa_recebimentos').select('*').gt('updated_at', since) : supabaseClient.from('casa_recebimentos').select('*'),
                    since ? supabaseClient.from('casa_despesas').select('*').gt('updated_at', since) : supabaseClient.from('casa_despesas').select('*'),
                    since ? supabaseClient.from('casa_reservas').select('*').gt('updated_at', since) : supabaseClient.from('casa_reservas').select('*'),
                    supabaseClient.from('user_settings').select('settings_json').single()
                ]);

                if (rRes.data?.length) {
                    rRes.data.forEach(r => {
                        const mapped = { id: r.id, data: r.date, valor: r.valor, descricao: r.descricao, fonte: r.fonte };
                        const idx = casaRecebimentos.findIndex(e => e.id === r.id);
                        if (idx === -1) casaRecebimentos.push(mapped); else casaRecebimentos[idx] = mapped;
                    });
                    localStorage.setItem(userKey('casa_recebimentos'), JSON.stringify(casaRecebimentos));
                }
                if (dRes.data?.length) {
                    dRes.data.forEach(r => {
                        const mapped = { id: r.id, data: r.date, valor: r.valor, categoria: r.categoria, descricao: r.descricao, status: r.status };
                        const idx = casaDespesas.findIndex(e => e.id === r.id);
                        if (idx === -1) casaDespesas.push(mapped); else casaDespesas[idx] = mapped;
                    });
                    localStorage.setItem(userKey('casa_despesas'), JSON.stringify(casaDespesas));
                }
                if (sRes.data?.length) {
                    sRes.data.forEach(r => {
                        const mapped = { id: r.id, data: r.date, valor: r.valor, tipo: r.tipo, observacao: r.observacao };
                        const idx = casaReservas.findIndex(e => e.id === r.id);
                        if (idx === -1) casaReservas.push(mapped); else casaReservas[idx] = mapped;
                    });
                    localStorage.setItem(userKey('casa_reservas'), JSON.stringify(casaReservas));
                }
                if (!since && stRes.data?.settings_json) {
                    casaSettings = { ...casaSettings, ...stRes.data.settings_json };
                    localStorage.setItem(userKey('casa_settings'), JSON.stringify(casaSettings));
                }
            }

            this.lastSyncAt = new Date().toISOString();
        } catch (err) {
            console.warn('[SyncEngine] loadIncremental falhou, usando cache local:', err.message);
        }
    },

    // ─── SINCRONIZAÇÃO DE ESCRITA (UPSERT/DELETE) ────────────────────
    // Enfileira a operação localmente, depois tenta enviar.
    // Se falhar, a fila de pendentes garante reenvio automático.

    async pushUpsert(table, record) {
        this.enqueue(table, record.id, 'UPSERT', record);
        await this.processQueue();
    },

    async pushDelete(table, recordId) {
        this.enqueue(table, recordId, 'DELETE', { id: recordId });
        await this.processQueue();
    },

    // ─── LOG DE AUDITORIA ────────────────────────────────────────────
    _logAudit(table, recordId, status, errorMsg = null) {
        try {
            const logs = JSON.parse(localStorage.getItem('sync_audit_local_v2') || '[]');
            logs.unshift({
                recordId, table, status, errorMsg,
                userId: currentUser?.supabaseUserId,
                timestamp: new Date().toISOString()
            });
            localStorage.setItem('sync_audit_local_v2', JSON.stringify(logs.slice(0, 300)));
        } catch (e) {}

        // Log remoto apenas para falhas (fire-and-forget, não bloqueia UI)
        if (supabaseClient && currentUser?.supabaseUserId && status === 'SYNC_FAILED' && errorMsg) {
            supabaseClient.from('sync_audit_log').insert({
                record_id: String(recordId),
                table_name: table,
                user_id: currentUser.supabaseUserId,
                operation: status,
                error_message: errorMsg?.substring(0, 500) || null
            }).then(() => {}).catch(() => {});
        }
    },

    // ─── APLICAÇÃO CIRÚRGICA DE EVENTO REALTIME ──────────────────────
    // Aplica somente o registro afetado em memória, sem reload completo.
    applyRealtimeEvent(eventType, table, newRec, oldRec) {
        const acc = currentUser?.accountType;

        const mergeInto = (arr, localMapper, r) => {
            if (eventType === 'DELETE') {
                return arr.filter(e => e.id !== (oldRec?.id || r?.id));
            }
            const mapped = localMapper(r);
            const idx = arr.findIndex(e => e.id === r.id);
            if (idx === -1) arr.push(mapped); else arr[idx] = mapped;
            return arr;
        };

        if (acc === 'uber') {
            if (table === 'uber_entries') {
                uberEntries = mergeInto(uberEntries, r => ({ id: r.id, date: r.date, gross: r.gross, fuel: r.fuel, other: r.other, otherDesc: r.other_desc, km: r.km }), newRec || oldRec);
                localStorage.setItem(userKey('uber_finance_entries'), JSON.stringify(uberEntries));
            } else if (table === 'personal_entries') {
                personalEntries = mergeInto(personalEntries, r => ({ id: r.id, date: r.date, category: r.category, value: r.value, status: r.status, desc: r.description }), newRec || oldRec);
                localStorage.setItem(userKey('uber_finance_personal_entries'), JSON.stringify(personalEntries));
            }
        } else if (acc === 'roupas') {
            if (table === 'estoque_items') {
                estoqueItems = mergeInto(estoqueItems, r => ({ id: r.id, nome: r.nome, categoria: r.categoria, tamanho: r.tamanho, qtd: r.qtd, custo: r.custo, precoVenda: r.preco_venda, dataEntrada: r.data_entrada }), newRec || oldRec);
                localStorage.setItem(userKey('roupas_estoque'), JSON.stringify(estoqueItems));
            } else if (table === 'compras_entries') {
                comprasEntries = mergeInto(comprasEntries, r => ({ id: r.id, data: r.date, produto: r.produto, qtd: r.qtd, custo: r.custo, transporte: r.transporte, fornecedor: r.fornecedor }), newRec || oldRec);
                localStorage.setItem(userKey('roupas_compras'), JSON.stringify(comprasEntries));
            } else if (table === 'vendas_entries') {
                vendasEntries = mergeInto(vendasEntries, r => ({ id: r.id, data: r.date, stockItemId: r.stock_item_id, produto: r.produto, tamanho: r.tamanho, qtd: r.qtd, valor: r.valor, custoRef: r.custo_ref, lucro: r.lucro, obs: r.obs }), newRec || oldRec);
                localStorage.setItem(userKey('roupas_vendas'), JSON.stringify(vendasEntries));
            }
        } else if (acc === 'grafica') {
            if (table === 'grafica_produtos') {
                graficaProdutos = mergeInto(graficaProdutos, r => ({ id: r.id, tipo: r.tipo, nome: r.nome, categoria: r.categoria, medidas: r.medidas, tipoPapel: r.tipo_papel, acabamento: r.acabamento, custoUnitario: r.custo_unitario, margemLucro: r.margem_lucro, precoVenda: r.preco_venda, qtdEstoque: r.qtd_estoque, estoqueMinimo: r.estoque_minimo }), newRec || oldRec);
                localStorage.setItem(userKey('grafica_produtos'), JSON.stringify(graficaProdutos));
            } else if (table === 'grafica_vendas') {
                graficaVendas = mergeInto(graficaVendas, r => ({ id: r.id, data: r.date, cliente: r.cliente, tipoItem: r.tipo_item, produtoId: r.produto_id, detalhes: r.detalhes, larguraCm: r.largura_cm, alturaCm: r.altura_cm, m2Total: r.m2_total, qtd: r.qtd, custoTotal: r.custo_total, precoTotal: r.preco_total, lucro: r.lucro, formaPagamento: r.forma_pagamento, obs: r.obs }), newRec || oldRec);
                localStorage.setItem(userKey('grafica_vendas'), JSON.stringify(graficaVendas));
            } else if (table === 'grafica_despesas_op') {
                graficaDespesasOp = mergeInto(graficaDespesasOp, r => ({ id: r.id, data: r.date, categoria: r.categoria, descricao: r.descricao, valor: r.valor, status: r.status }), newRec || oldRec);
                localStorage.setItem(userKey('grafica_despesas_op'), JSON.stringify(graficaDespesasOp));
            } else if (table === 'grafica_despesas_pessoais') {
                graficaDespesasPessoais = mergeInto(graficaDespesasPessoais, r => ({ id: r.id, vencimento: r.vencimento, pagamento: r.pagamento, categoria: r.categoria, valor: r.valor, status: r.status, descricao: r.descricao }), newRec || oldRec);
                localStorage.setItem(userKey('grafica_despesas_pessoais'), JSON.stringify(graficaDespesasPessoais));
            }
        } else if (acc === 'casa') {
            if (table === 'casa_recebimentos') {
                casaRecebimentos = mergeInto(casaRecebimentos, r => ({ id: r.id, data: r.date, valor: r.valor, descricao: r.descricao, fonte: r.fonte }), newRec || oldRec);
                localStorage.setItem(userKey('casa_recebimentos'), JSON.stringify(casaRecebimentos));
            } else if (table === 'casa_despesas') {
                casaDespesas = mergeInto(casaDespesas, r => ({ id: r.id, data: r.date, valor: r.valor, categoria: r.categoria, descricao: r.descricao, status: r.status }), newRec || oldRec);
                localStorage.setItem(userKey('casa_despesas'), JSON.stringify(casaDespesas));
            } else if (table === 'casa_reservas') {
                casaReservas = mergeInto(casaReservas, r => ({ id: r.id, data: r.date, valor: r.valor, tipo: r.tipo, observacao: r.observacao }), newRec || oldRec);
                localStorage.setItem(userKey('casa_reservas'), JSON.stringify(casaReservas));
            }
        }
    }
};

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
let graficaCosts = {};
let editingGraficaProdutoId = null;
let editingGraficaDespesaOpId = null;
let editingGraficaDespesaPessoalId = null;
let graficaSettings = {
    backupEmail: '',
    emailjsServiceId: '',
    emailjsTemplateId: '',
    emailjsPublicKey: ''
};

// Controle de Casa state
let casaRecebimentos = [];
let casaDespesas = [];
let casaReservas = []; // Dinheiro guardado (cofrinho)
let editingCasaRecebId = null;
let editingCasaDespId = null;
let editingCasaResId = null;
let casaSettings = {
    backupEmail: '',
    emailjsServiceId: '',
    emailjsTemplateId: '',
    emailjsPublicKey: ''
};
const CASA_CATEGORIAS = ['Aluguel', 'Luz', 'Água', 'Remédio', 'Escola', 'Mercado', 'Saídas', 'Outros'];

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
    const acc = currentUser ? currentUser.accountType : 'uber';
    let dataObj = {};
    let setObj = {};
    
    if (acc === 'uber') {
        dataObj = { uberEntries, personalEntries };
        setObj = uberSettings;
    } else if (acc === 'roupas') {
        dataObj = { estoqueItems, comprasEntries, vendasEntries };
        setObj = roupasSettings;
    } else if (acc === 'grafica') {
        dataObj = { graficaProdutos, graficaVendas, graficaDespesasOp, graficaDespesasPessoais };
        setObj = graficaSettings;
    } else if (acc === 'casa') {
        dataObj = { casaRecebimentos, casaDespesas, casaReservas };
        setObj = casaSettings;
    }

    return {
        system: "Controle Financeiro",
        version: "2.1",
        user: currentUser ? currentUser.username : 'guest',
        userName: currentUser ? currentUser.name : 'Convidado',
        accountType: acc,
        backupDate: todayISO(),
        timestamp: new Date().toISOString(),
        settings: setObj,
        data: dataObj
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
            : backupObj.accountType === 'roupas'
            ? `${estoqueItems.length} produtos | ${vendasEntries.length} vendas`
            : backupObj.accountType === 'grafica'
            ? `${graficaProdutos.length} opções | ${graficaVendas.length} vendas`
            : `${casaRecebimentos.length} rec. | ${casaDespesas.length} desp. | ${casaReservas.length} res.`,
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
        let st = uberSettings;
        if (currentUser.accountType === 'roupas') st = roupasSettings;
        else if (currentUser.accountType === 'grafica') st = graficaSettings;
        else if (currentUser.accountType === 'casa') st = casaSettings;
        if (st.backupEmail && st.emailjsServiceId && st.emailjsTemplateId && st.emailjsPublicKey) {
            sendEmailBackup(false);
        }
    }
}

async function sendEmailBackup(manualTest = false) {
    if (!currentUser) return;
    const acc = currentUser.accountType;
    let st = uberSettings;
    if (acc === 'roupas') st = roupasSettings;
    if (acc === 'grafica') st = graficaSettings;
    if (acc === 'casa') st = casaSettings;

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
        let accName = 'App';
        if (acc === 'uber') {
            summaryText = `Lançamentos Uber: ${uberEntries.length} | Despesas Casa: ${personalEntries.length}`;
            accName = 'Motorista Uber';
        } else if (acc === 'roupas') {
            summaryText = `Itens Estoque: ${estoqueItems.length} | Compras: ${comprasEntries.length} | Vendas: ${vendasEntries.length}`;
            accName = 'Vendedor de Roupas';
        } else if (acc === 'grafica') {
            summaryText = `Itens Estoque: ${graficaProdutos.length} | Vendas: ${graficaVendas.length}`;
            accName = 'Gráfica Rápida';
        } else if (acc === 'casa') {
            summaryText = `Recebimentos: ${casaRecebimentos.length} | Despesas: ${casaDespesas.length} | Reservas: ${casaReservas.length}`;
            accName = 'Controle de Casa';
        }

        const templateParams = {
            to_email: st.backupEmail,
            from_name: currentUser.name,
            backup_date: dateBR(todayISO()),
            account_type: accName,
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
                // Garante que o supabaseUserId seja preenchido se houver sessão Supabase ativa
                if (supabaseClient && !currentUser.supabaseUserId) {
                    supabaseClient.auth.getUser().then(({ data }) => {
                        if (data && data.user) {
                            currentUser.supabaseUserId = data.user.id;
                            localStorage.setItem('uber_finance_logged_user', JSON.stringify(currentUser));
                            if (realtimeChannel) subscribeRealtime(); else subscribeRealtime();
                        }
                    }).catch(() => {});
                }
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
// AUTH & SECURITY UTILS
// =====================================================
async function hashPassword(password) {
    const encoder = new TextEncoder();
    const data = encoder.encode(password);
    const hash = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

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
    // Delegado para SyncEngine.loadIncremental() - sync incremental por delta
    await SyncEngine.loadIncremental();
}

let realtimeChannel = null;

function getRealtimeTables() {
    if (!currentUser) return [];
    if (currentUser.accountType === 'uber') return ['uber_entries', 'personal_entries', 'user_settings'];
    if (currentUser.accountType === 'roupas') return ['estoque_items', 'compras_entries', 'vendas_entries', 'user_settings'];
    if (currentUser.accountType === 'grafica') return ['grafica_produtos', 'grafica_vendas', 'grafica_despesas_op', 'grafica_despesas_pessoais', 'user_settings'];
    if (currentUser.accountType === 'casa') return ['casa_recebimentos', 'casa_despesas', 'casa_reservas', 'user_settings'];
    return [];
}

function subscribeRealtime() {
    if (!supabaseClient || !currentUser) return;
    unsubscribeRealtime();

    const tables = getRealtimeTables();
    if (!tables.length) return;

    const channelVersion = ++SyncEngine.syncVersion;

    const channel = supabaseClient.channel('db-sync-v2-' + currentUser.accountType + '-' + currentUser.username, {
        config: { broadcast: { self: false }, presence: { key: currentUser.username } }
    });

    tables.forEach(table => {
        channel.on(
            'postgres_changes',
            { event: '*', schema: 'public', table: table },
            (payload) => {
                if (channelVersion !== SyncEngine.syncVersion) return;
                if (SyncEngine.activeSyncVersion > 0) return;
                const rec = payload.new || payload.old;
                if (rec && rec.user_id && currentUser && rec.user_id !== currentUser.supabaseUserId) return;
                handleRealtimeChange(payload);
            }
        );
    });

    channel.subscribe((status) => {
        if (status === 'SUBSCRIBED') {
            console.log('[Realtime] Conectado para ' + currentUser.accountType);
            SyncEngine.loadIncremental().catch(e => console.warn('[Realtime] loadIncremental pos-reconexao falhou:', e.message));
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
            console.warn('[Realtime] Status ' + status + ' - reconectando em 5s');
            setTimeout(() => { if (currentUser) subscribeRealtime(); }, 5000);
        }
    });

    realtimeChannel = channel;
}

function unsubscribeRealtime() {
    if (realtimeChannel && supabaseClient) {
        supabaseClient.removeChannel(realtimeChannel);
        realtimeChannel = null;
    }
}

let realtimeRenderTimer = null;
function handleRealtimeChange(payload) {
    const { eventType, table, new: newRec, old: oldRec } = payload;
    SyncEngine.applyRealtimeEvent(eventType, table, newRec, oldRec);

    if (realtimeRenderTimer) clearTimeout(realtimeRenderTimer);
    realtimeRenderTimer = setTimeout(() => {
        realtimeRenderTimer = null;
        lastSyncTimeStr = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        updateSyncTimeUI();

        if (currentUser.accountType === 'uber') {
            populateUberMonthFilter();
            renderUberApp();
        } else if (currentUser.accountType === 'roupas') {
            populateRoupasMonthFilter();
            renderRoupasApp();
        } else if (currentUser.accountType === 'grafica') {
            populateGraficaMonthFilter();
            renderGraficaApp();
        } else if (currentUser.accountType === 'casa') {
            populateCasaMonthFilter();
            renderCasaApp();
        }
        showToast('Dados atualizados de outro dispositivo', 'info');
    }, 80);
}

let lastSyncTimeStr = 'Salvo';
function updateSyncTimeUI() {
    const uBtn = document.getElementById('uberSyncTime');
    const rBtn = document.getElementById('roupasSyncTime');
    const gBtn = document.getElementById('graficaSyncTime');
    const cBtn = document.getElementById('casaSyncTime');
    if (uBtn) uBtn.textContent = lastSyncTimeStr;
    if (rBtn) rBtn.textContent = lastSyncTimeStr;
    if (gBtn) gBtn.textContent = lastSyncTimeStr;
    if (cBtn) cBtn.textContent = lastSyncTimeStr;
}

window.manualCloudSync = async function(btnId, timeId) {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Sincronizando...';
    await SyncEngine.processQueue();
    await SyncEngine.loadIncremental();
    lastSyncTimeStr = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    btn.innerHTML = '<i class="fa-solid fa-cloud-check"></i> <span id="' + timeId + '">' + lastSyncTimeStr + '</span>';
    updateSyncTimeUI();
    showToast('Sincronizado com a nuvem!', 'success');
};

async function deleteCloudItem(table, id) {
    if (!supabaseClient || !currentUser) return;
    await SyncEngine.pushDelete(table, id).catch(err => {
        console.warn('[deleteCloudItem] Enfileirado para retry:', err.message);
    });
}

let cloudSaveTimer = null;
async function syncCloudSave() {
    if (!supabaseClient || !currentUser) return;
    await SyncEngine.processQueue();
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
            await setCurrentUser({ name, username, accountType: typeRadio.value });
            document.getElementById('registerForm').reset();
            await startSession();
            return;
        } catch(err) {
            showError('regErrorMsg', 'Erro de conexão com o Supabase.');
            return;
        }
    }

    // Fallback local se Supabase não configurado
    const hashedPass = await hashPassword(password);
    const user = { name, username, password: hashedPass, accountType: typeRadio.value };
    usersList.push(user);
    saveUsers();
    await setCurrentUser({ name, username, accountType: typeRadio.value });
    document.getElementById('registerForm').reset();
    await startSession();
}

async function handleLogin(e) {
    e.preventDefault();
    clearAuthErrors();

    const username = document.getElementById('loginUsername').value.trim().toLowerCase();
    const password = document.getElementById('loginPassword').value;
    const hashedPass = await hashPassword(password);

    let loginSuccess = false;
    let localFound = usersList.find(u => u.username === username && (u.password === password || u.password === hashedPass));

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
                const baseUser = profile 
                    ? { name: profile.name, username: profile.username, accountType: profile.account_type }
                    : (localFound ? { name: localFound.name, username: localFound.username, accountType: localFound.accountType } : { name: username, username, accountType: 'uber' });
                await setCurrentUser(baseUser);

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
        await setCurrentUser({ name: localFound.name, username: localFound.username, accountType: localFound.accountType });
        document.getElementById('loginForm').reset();
        await startSession();
        return;
    }

    // Se não encontrou nem no Supabase nem local
    showError('loginErrorMsg', 'Usuário ou senha incorretos.');
}

function handleLogout() {
    if (!confirm('Deseja sair do sistema?')) return;
    unsubscribeRealtime();
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
    document.getElementById('casaApp').classList.add('hidden');
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
        } else if (currentUser.accountType === 'casa') {
            startCasaSession();
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

    subscribeRealtime();
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
function saveUberEntries(changedEntry) {
    localStorage.setItem(userKey('uber_finance_entries'), JSON.stringify(uberEntries));
    if (supabaseClient && currentUser && changedEntry) {
        supabaseClient.auth.getUser().then(({ data: { user } }) => {
            if (!user) return;
            SyncEngine.pushUpsert('uber_entries', {
                id: changedEntry.id, user_id: user.id,
                date: changedEntry.date, gross: changedEntry.gross,
                fuel: changedEntry.fuel, other: changedEntry.other,
                other_desc: changedEntry.otherDesc, km: changedEntry.km
            });
        }).catch(() => syncCloudSave());
    } else { syncCloudSave(); }
}

function loadPersonalEntries() {
    const d = localStorage.getItem(userKey('uber_finance_personal_entries'));
    personalEntries = d ? JSON.parse(d) : [];
}
function savePersonalEntries(changedEntry) {
    localStorage.setItem(userKey('uber_finance_personal_entries'), JSON.stringify(personalEntries));
    if (supabaseClient && currentUser && changedEntry) {
        supabaseClient.auth.getUser().then(({ data: { user } }) => {
            if (!user) return;
            SyncEngine.pushUpsert('personal_entries', {
                id: changedEntry.id, user_id: user.id,
                date: changedEntry.date, category: changedEntry.category,
                value: changedEntry.value, status: changedEntry.status,
                description: changedEntry.desc
            });
        }).catch(() => syncCloudSave());
    } else { syncCloudSave(); }
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

    document.getElementById('importCsvFile').onchange = (e) => {
        if (e.target.files[0]) {
            if (confirm('Importar dados do CSV? Dados duplicados serão ignorados.')) {
                importUberCSV(e.target.files[0]);
            }
            e.target.value = '';
        }
    };

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

    document.getElementById('importJsonFile').onchange = (e) => {
        if (e.target.files[0]) restoreJSONBackup(e.target.files[0]);
        e.target.value = '';
    };
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
            <td data-label="Data"><strong>${dateBR(item.date)}</strong></td>
            <td data-label="Faturamento" class="text-success">${fmt(g)}</td>
            <td data-label="Gasolina" class="text-danger">${fmt(f)}</td>
            <td data-label="Outros">${fmt(o)}</td>
            <td data-label="Despesas" class="text-danger"><strong>${fmt(exp)}</strong></td>
            <td data-label="Lucro" class="text-success"><strong>${fmt(n)}</strong></td>
            <td data-label="Obs/KM">${item.otherDesc||'-'}${item.km?`<br><small class="text-muted">${item.km} km</small>`:''}</td>
            <td data-label="Ações" class="text-center"><div class="action-btns">
                <button class="action-btn action-edit" title="Editar" onclick="editUber('${item.id}')"><i class="fa-solid fa-pen"></i></button>
                <button class="action-btn action-delete" title="Excluir" onclick="deleteUber('${item.id}')"><i class="fa-solid fa-trash"></i></button>
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
            <td data-label="Data"><strong>${dateBR(item.date)}</strong></td>
            <td data-label="Categoria"><span class="badge-category">${item.category}</span></td>
            <td data-label="Descrição">${item.desc||'-'}</td>
            <td data-label="Valor" class="text-danger"><strong>${fmt(v)}</strong></td>
            <td data-label="Status"><span class="status-badge ${sc}">${item.status==='Pago'?'✅ Pago':'⏳ Pendente'}</span></td>
            <td data-label="Ações" class="text-center"><div class="action-btns">
                <button class="action-btn action-edit" title="Editar" onclick="editPersonal('${item.id}')"><i class="fa-solid fa-pen"></i></button>
                <button class="action-btn action-delete" title="Excluir" onclick="deletePersonal('${item.id}')"><i class="fa-solid fa-trash"></i></button>
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
    const id = document.getElementById('entryId').value || generateId();
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
    saveUberEntries(entry);
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
    const id = document.getElementById('personalId').value || generateId();
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
    savePersonalEntries(entry);
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

    subscribeRealtime();
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

    document.getElementById('roupasImportCsvFile').onchange = (e) => {
        if (e.target.files[0]) {
            if (confirm('Importar dados do CSV? Dados duplicados serão ignorados.')) {
                importRoupasCSV(e.target.files[0]);
            }
            e.target.value = '';
        }
    };

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

    document.getElementById('roupasImportJsonFile').onchange = (e) => {
        if (e.target.files[0]) restoreJSONBackup(e.target.files[0]);
        e.target.value = '';
    };
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
            <td data-label="Data"><strong>${dateBR(item.data)}</strong></td>
            <td data-label="Produto">${item.produto}</td>
            <td data-label="Qtd">${item.qtd||'-'}</td>
            <td data-label="Mercadoria" class="text-danger">${fmtR(c)}</td>
            <td data-label="Transporte" class="text-danger">${fmtR(t)}</td>
            <td data-label="Total" class="text-danger"><strong>${fmtR(c+t)}</strong></td>
            <td data-label="Fornecedor">${item.fornecedor||'-'}</td>
            <td data-label="Ações" class="text-center"><div class="action-btns">
                <button class="action-btn action-edit" title="Editar" onclick="editCompra('${item.id}')"><i class="fa-solid fa-pen"></i></button>
                <button class="action-btn action-delete" title="Excluir" onclick="deleteCompra('${item.id}')"><i class="fa-solid fa-trash"></i></button>
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
            <td data-label="Data"><strong>${dateBR(item.data)}</strong></td>
            <td data-label="Produto">${item.produto}</td>
            <td data-label="Tamanho"><span class="badge-category">${item.tamanho||'-'}</span></td>
            <td data-label="Qtd"><strong>${item.qtd||1}</strong></td>
            <td data-label="Valor" class="text-success"><strong>${fmtR(v)}</strong></td>
            <td data-label="Custo" class="text-danger">${fmtR(c)}</td>
            <td data-label="Lucro" class="${l >= 0 ? 'text-success' : 'text-danger'}"><strong>${fmtR(l)}</strong></td>
            <td data-label="Margem" class="${l >= 0 ? 'text-success' : 'text-danger'}">${margem !== '-' ? margem + '%' : '-'}</td>
            <td data-label="Obs">${item.obs||'-'}</td>
            <td data-label="Ações" class="text-center"><div class="action-btns">
                <button class="action-btn action-edit" title="Editar" onclick="editVenda('${item.id}')"><i class="fa-solid fa-pen"></i></button>
                <button class="action-btn action-delete" title="Excluir" onclick="deleteVenda('${item.id}')"><i class="fa-solid fa-trash"></i></button>
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
    const id = document.getElementById('estoqueId').value || generateId();
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
    const id = document.getElementById('compraId').value || generateId();
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
    const id = document.getElementById('vendaId').value || generateId();
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

function parseDateBR(d) {
    if (!d) return '';
    d = d.trim().replace(/"/g, '');
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
    const parts = d.split('/');
    if (parts.length === 3) return `${parts[2]}-${parts[1].padStart(2,'0')}-${parts[0].padStart(2,'0')}`;
    return '';
}

function parseCSVLine(line, sep) {
    const result = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inQuotes) {
            if (ch === '"' && line[i+1] === '"') { current += '"'; i++; }
            else if (ch === '"') inQuotes = false;
            else current += ch;
        } else {
            if (ch === '"') inQuotes = true;
            else if (ch === sep) { result.push(current.trim()); current = ''; }
            else current += ch;
        }
    }
    result.push(current.trim());
    return result;
}

function readFileAsText(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsText(file, 'UTF-8');
    });
}

function detectSeparator(text) {
    const firstLines = text.split('\n').slice(0, 5).join('');
    const semicolons = (firstLines.match(/;/g) || []).length;
    const commas = (firstLines.match(/,/g) || []).length;
    return semicolons >= commas ? ';' : ',';
}

async function restoreJSONBackup(file) {
    if (!confirm('Atenção: A restauração substituirá TODOS os dados atuais por este backup. Essa ação é irreversível. Deseja continuar?')) return;
    
    try {
        const text = await readFileAsText(file);
        const obj = JSON.parse(text);
        
        if (!obj.data || !obj.accountType) {
            throw new Error('Arquivo de backup inválido ou incompatível.');
        }

        if (obj.accountType !== currentUser.accountType) {
            throw new Error(`Este backup é do tipo '${obj.accountType}', mas sua conta atual é '${currentUser.accountType}'.`);
        }

        if (obj.accountType === 'uber') {
            if (obj.data.uberEntries) uberEntries = obj.data.uberEntries;
            if (obj.data.personalEntries) personalEntries = obj.data.personalEntries;
            if (obj.settings) uberSettings = obj.settings;
            localStorage.setItem(userKey('uber_finance_entries'), JSON.stringify(uberEntries));
            localStorage.setItem(userKey('uber_finance_personal_entries'), JSON.stringify(personalEntries));
            localStorage.setItem(userKey('uber_finance_settings'), JSON.stringify(uberSettings));
            populateUberMonthFilter();
            renderUberApp();
        } else if (obj.accountType === 'roupas') {
            if (obj.data.estoqueItems) estoqueItems = obj.data.estoqueItems;
            if (obj.data.comprasEntries) comprasEntries = obj.data.comprasEntries;
            if (obj.data.vendasEntries) vendasEntries = obj.data.vendasEntries;
            if (obj.settings) roupasSettings = obj.settings;
            localStorage.setItem(userKey('roupas_estoque'), JSON.stringify(estoqueItems));
            localStorage.setItem(userKey('roupas_compras'), JSON.stringify(comprasEntries));
            localStorage.setItem(userKey('roupas_vendas'), JSON.stringify(vendasEntries));
            localStorage.setItem(userKey('roupas_finance_settings'), JSON.stringify(roupasSettings));
            populateRoupasMonthFilter();
            renderRoupasApp();
        } else if (obj.accountType === 'grafica') {
            if (obj.data.graficaProdutos) graficaProdutos = obj.data.graficaProdutos;
            if (obj.data.graficaVendas) graficaVendas = obj.data.graficaVendas;
            if (obj.data.graficaDespesasOp) graficaDespesasOp = obj.data.graficaDespesasOp;
            if (obj.data.graficaDespesasPessoais) graficaDespesasPessoais = obj.data.graficaDespesasPessoais;
            if (obj.settings) graficaSettings = obj.settings;
            localStorage.setItem(userKey('grafica_produtos'), JSON.stringify(graficaProdutos));
            localStorage.setItem(userKey('grafica_vendas'), JSON.stringify(graficaVendas));
            localStorage.setItem(userKey('grafica_despesas_op'), JSON.stringify(graficaDespesasOp));
            localStorage.setItem(userKey('grafica_despesas_pessoais'), JSON.stringify(graficaDespesasPessoais));
            localStorage.setItem(userKey('grafica_settings'), JSON.stringify(graficaSettings));
            populateGraficaMonthFilter();
            renderGraficaApp();
        } else if (obj.accountType === 'casa') {
            if (obj.data.casaRecebimentos) casaRecebimentos = obj.data.casaRecebimentos;
            if (obj.data.casaDespesas) casaDespesas = obj.data.casaDespesas;
            if (obj.data.casaReservas) casaReservas = obj.data.casaReservas;
            if (obj.settings) casaSettings = obj.settings;
            localStorage.setItem(userKey('casa_recebimentos'), JSON.stringify(casaRecebimentos));
            localStorage.setItem(userKey('casa_despesas'), JSON.stringify(casaDespesas));
            localStorage.setItem(userKey('casa_reservas'), JSON.stringify(casaReservas));
            localStorage.setItem(userKey('casa_settings'), JSON.stringify(casaSettings));
            populateCasaMonthFilter();
            renderCasaApp();
        }

        // Tenta sincronizar a nuvem após restauração local
        if (supabaseClient) {
            await syncCloudSave();
        }
        
        showToast('Backup JSON restaurado com sucesso!', 'success');
        
        // Fechar modais abertos
        document.getElementById('settingsModal')?.classList.add('hidden');
        document.getElementById('roupasSettingsModal')?.classList.add('hidden');
        document.getElementById('graficaSettingsModal')?.classList.add('hidden');
        document.getElementById('casaSettingsModal')?.classList.add('hidden');
        
    } catch(err) {
        console.error('Erro na restauração:', err);
        alert('Erro ao restaurar backup:\n' + err.message);
    }
}

// =====================================================
// CSV IMPORT — UBER
// =====================================================
async function importUberCSV(file) {
    try {
        const text = await readFileAsText(file);
        const sep = detectSeparator(text);
        const lines = text.split('\n').map(l => l.replace(/\r/g, '').replace(/^\uFEFF/, ''));

        let section = '';
        let uberImported = 0, personalImported = 0;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;

            if (line.startsWith('=== UBER')) { section = 'uber'; continue; }
            if (line.startsWith('=== CASA')) { section = 'casa'; continue; }
            if (line.startsWith('=== SALDO') || line.startsWith('=== RESUMO')) { section = ''; continue; }

            if (section === 'uber') {
                if (line.startsWith('Data') || line.startsWith('TOTAL')) continue;
                const cols = parseCSVLine(line, sep);
                if (cols.length < 6) continue;
                const date = parseDateBR(cols[0]);
                if (!date) continue;
                const entry = {
                    id: generateId(),
                    date,
                    gross: parseFloat(cols[1]) || 0,
                    fuel: parseFloat(cols[2]) || 0,
                    other: parseFloat(cols[3]) || 0,
                    otherDesc: cols[7] ? cols[7].replace(/"/g, '') : '',
                    km: cols[6] ? parseFloat(cols[6]) || null : null
                };
                if (!uberEntries.find(e => e.date === entry.date && e.gross === entry.gross && e.fuel === entry.fuel)) {
                    uberEntries.push(entry);
                    uberImported++;
                }
            }

            if (section === 'casa') {
                if (line.startsWith('Data') || line.startsWith('TOTAL')) continue;
                const cols = parseCSVLine(line, sep);
                if (cols.length < 4) continue;
                const date = parseDateBR(cols[0]);
                if (!date) continue;
                const entry = {
                    id: generateId(),
                    date,
                    category: cols[1] || 'Outros',
                    desc: cols[2] ? cols[2].replace(/"/g, '') : '',
                    value: parseFloat(cols[3]) || 0,
                    status: cols[4] || 'Pendente'
                };
                if (!personalEntries.find(e => e.date === entry.date && e.category === entry.category && e.value === entry.value)) {
                    personalEntries.push(entry);
                    personalImported++;
                }
            }
        }

        if (uberImported === 0 && personalImported === 0) {
            showToast('Nenhum dado novo encontrado no CSV. Verifique o formato do arquivo.', 'warning');
            return;
        }

        saveUberEntries();
        savePersonalEntries();
        populateUberMonthFilter();
        renderUberApp();
        showToast(`Importado: ${uberImported} lancamento(s) Uber + ${personalImported} despesa(s) Casa`, 'success');
    } catch(err) {
        console.error('Erro ao importar CSV Uber:', err);
        showToast('Erro ao importar CSV: ' + err.message, 'error');
    }
}

// =====================================================
// CSV IMPORT — ROUPAS
// =====================================================
async function importRoupasCSV(file) {
    try {
        const text = await readFileAsText(file);
        const sep = detectSeparator(text);
        const lines = text.split('\n').map(l => l.replace(/\r/g, '').replace(/^\uFEFF/, ''));

        let section = '';
        let estoqueImported = 0, comprasImported = 0, vendasImported = 0;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;

            if (line.startsWith('=== ESTOQUE')) { section = 'estoque'; continue; }
            if (line.startsWith('=== COMPRAS')) { section = 'compras'; continue; }
            if (line.startsWith('=== VENDAS')) { section = 'vendas'; continue; }
            if (line.startsWith('=== RESUMO') || line.startsWith('=== SALDO')) { section = ''; continue; }

            if (section === 'estoque') {
                if (line.startsWith('Produto') || line.startsWith('TOTAL')) continue;
                const cols = parseCSVLine(line, sep);
                if (cols.length < 5) continue;
                const nome = cols[0].replace(/"/g, '');
                if (!nome) continue;
                if (!estoqueItems.find(e => e.nome === nome && e.categoria === cols[1])) {
                    estoqueItems.push({
                        id: generateId(),
                        nome,
                        categoria: cols[1] || 'Camiseta',
                        tamanho: 'M',
                        qtd: parseInt(cols[2]) || 0,
                        custo: parseFloat(cols[3]) || 0,
                        precoVenda: parseFloat(cols[4]) || 0,
                        dataEntrada: parseDateBR(cols[5]) || todayISO()
                    });
                    estoqueImported++;
                }
            }

            if (section === 'compras') {
                if (line.startsWith('Data') || line.startsWith('TOTAL')) continue;
                const cols = parseCSVLine(line, sep);
                if (cols.length < 4) continue;
                const data = parseDateBR(cols[0]);
                if (!data) continue;
                const produto = cols[1] ? cols[1].replace(/"/g, '') : '';
                const custo = parseFloat(cols[3]) || 0;
                if (!comprasEntries.find(e => e.data === data && e.produto === produto && e.custo === custo)) {
                    comprasEntries.push({
                        id: generateId(),
                        data,
                        produto,
                        qtd: parseInt(cols[2]) || null,
                        custo,
                        transporte: parseFloat(cols[4]) || 0,
                        fornecedor: cols[6] ? cols[6].replace(/"/g, '') : ''
                    });
                    comprasImported++;
                }
            }

            if (section === 'vendas') {
                if (line.startsWith('Data') || line.startsWith('TOTAL')) continue;
                const cols = parseCSVLine(line, sep);
                if (cols.length < 5) continue;
                const data = parseDateBR(cols[0]);
                if (!data) continue;
                const produto = cols[1] ? cols[1].replace(/"/g, '') : '';
                const valor = parseFloat(cols[3]) || 0;
                const custoRef = parseFloat(cols[4]) || 0;
                if (!vendasEntries.find(e => e.data === data && e.produto === produto && e.valor === valor)) {
                    vendasEntries.push({
                        id: generateId(),
                        data,
                        stockItemId: '',
                        produto,
                        tamanho: 'M',
                        qtd: parseInt(cols[2]) || 1,
                        valor,
                        custoRef,
                        lucro: parseFloat(cols[5]) || (valor - custoRef),
                        obs: cols[6] ? cols[6].replace(/"/g, '') : ''
                    });
                    vendasImported++;
                }
            }
        }

        if (estoqueImported === 0 && comprasImported === 0 && vendasImported === 0) {
            showToast('Nenhum dado novo encontrado no CSV. Verifique o formato do arquivo.', 'warning');
            return;
        }

        if (estoqueImported) saveEstoque();
        if (comprasImported) saveCompras();
        if (vendasImported) saveVendas();
        populateRoupasMonthFilter();
        renderRoupasApp();
        showToast(`Importado: ${estoqueImported} produto(s) + ${comprasImported} compra(s) + ${vendasImported} venda(s)`, 'success');
    } catch(err) {
        console.error('Erro ao importar CSV Roupas:', err);
        showToast('Erro ao importar CSV: ' + err.message, 'error');
    }
}

// =====================================================
// CSV IMPORT — GRÁFICA
// =====================================================
async function importGraficaCSV(file) {
    try {
        const text = await readFileAsText(file);
        const sep = detectSeparator(text);
        const lines = text.split('\n').map(l => l.replace(/\r/g, '').replace(/^\uFEFF/, ''));

        let imported = 0;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;
            if (line.startsWith('Data') || line.startsWith('TOTAL')) continue;

            const cols = parseCSVLine(line, sep);
            if (cols.length < 8) continue;
            const data = parseDateBR(cols[0]);
            if (!data) continue;

            const cliente = cols[1] ? cols[1].replace(/"/g, '') : '';
            const precoTotal = parseFloat(cols[6]) || 0;

            if (!graficaVendas.find(e => e.data === data && e.cliente === cliente && e.precoTotal === precoTotal)) {
                graficaVendas.push({
                    id: generateId(),
                    data,
                    cliente,
                    tipoItem: cols[2] ? cols[2].replace(/"/g, '') : '',
                    detalhes: cols[3] ? cols[3].replace(/"/g, '') : '',
                    produtoId: '',
                    larguraCm: 0,
                    alturaCm: 0,
                    m2Total: 0,
                    qtd: parseInt(cols[4]) || 1,
                    custoTotal: parseFloat(cols[5]) || 0,
                    precoTotal,
                    lucro: parseFloat(cols[7]) || 0,
                    formaPagamento: cols[8] ? cols[8].replace(/"/g, '') : '',
                    obs: cols[9] ? cols[9].replace(/"/g, '') : ''
                });
                imported++;
            }
        }

        if (imported === 0) {
            showToast('Nenhum dado novo encontrado no CSV. Verifique o formato do arquivo.', 'warning');
            return;
        }

        saveGraficaVendas();
        populateGraficaMonthFilter();
        renderGraficaApp();
        showToast(`Importado: ${imported} venda(s) da gráfica`, 'success');
    } catch(err) {
        console.error('Erro ao importar CSV Gráfica:', err);
        showToast('Erro ao importar CSV: ' + err.message, 'error');
    }
}

function chartOpts(symbol) {
    const isMobile = window.innerWidth <= 768;
    return {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
            legend: {
                labels: { color: '#94a3b8', boxWidth: isMobile ? 10 : 40, font: { size: isMobile ? 10 : 12 } },
                position: isMobile ? 'bottom' : 'top'
            }
        },
        scales: {
            x: { ticks: { color: '#94a3b8', font: { size: isMobile ? 9 : 11 }, maxRotation: 45, autoSkip: true, maxTicksLimit: isMobile ? 8 : 31 } },
            y: { ticks: { color: '#94a3b8', font: { size: isMobile ? 9 : 11 }, callback: v => symbol + ' ' + v.toLocaleString() } }
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

    document.getElementById('graficaImportCsvFile').onchange = (e) => {
        if (e.target.files[0]) {
            if (confirm('Importar dados do CSV? Dados duplicados serão ignorados.')) {
                importGraficaCSV(e.target.files[0]);
            }
            e.target.value = '';
        }
    };

    renderGraficaApp();

    subscribeRealtime();
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
    if (graficaSettings && graficaSettings.costs) {
        graficaCosts = graficaSettings.costs;
    } else {
        const d = localStorage.getItem(userKey('grafica_costs'));
        graficaCosts = d ? JSON.parse(d) : {};
    }

    // Gera o conjunto de chaves válidas atuais do catálogo
    const validKeys = new Set();
    pdvCatalog.forEach(prod => {
        if (prod.group === 'A') {
            (prod.tamanhos || []).forEach(t =>
                (prod.papel || []).forEach(p =>
                    (prod.cores || []).forEach(c =>
                        (prod.tiragens || []).forEach(q => validKeys.add(`${prod.id}_${t}_${p}_${c}_${q}`))
                    )
                )
            );
        } else if (prod.group === 'B') {
            (prod.tamanhos || []).forEach(t =>
                (prod.papel || []).forEach(p =>
                    (prod.cores || []).forEach(c => validKeys.add(`${prod.id}_${t}_${p}_${c}`))
                )
            );
        } else if (prod.group === 'C') {
            (prod.materiais || []).forEach(m => validKeys.add(`${prod.id}_${m}`));
        }
    });

    // Remove chaves que não existem mais no catálogo atual
    for (const k of Object.keys(graficaPrices)) {
        if (!validKeys.has(k)) delete graficaPrices[k];
    }
    for (const k of Object.keys(graficaCosts)) {
        if (!validKeys.has(k)) delete graficaCosts[k];
    }
}
function saveGraficaPrices() {
    graficaSettings.prices = graficaPrices;
    graficaSettings.costs = graficaCosts;
    saveGraficaSettings();
    showToast('Tabela de Preços e Custos salva!', 'success');
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
        id: 'seed_matrix_' + idx + '_' + generateId(),
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

// =====================================================
// CONTROLE DE CASA MODULE
// =====================================================
function loadCasaSettings() {
    const d = localStorage.getItem(userKey('casa_settings'));
    casaSettings = d ? JSON.parse(d) : { backupEmail: '', emailjsServiceId: '', emailjsTemplateId: '', emailjsPublicKey: '' };
}
function saveCasaSettings() {
    localStorage.setItem(userKey('casa_settings'), JSON.stringify(casaSettings));
    syncCloudSave();
}

function loadCasaReceb() {
    const d = localStorage.getItem(userKey('casa_recebimentos'));
    casaRecebimentos = d ? JSON.parse(d) : [];
}
function saveCasaReceb() {
    localStorage.setItem(userKey('casa_recebimentos'), JSON.stringify(casaRecebimentos));
    syncCloudSave();
}

function loadCasaDesp() {
    const d = localStorage.getItem(userKey('casa_despesas'));
    casaDespesas = d ? JSON.parse(d) : [];
}
function saveCasaDesp() {
    localStorage.setItem(userKey('casa_despesas'), JSON.stringify(casaDespesas));
    syncCloudSave();
}

function loadCasaRes() {
    const d = localStorage.getItem(userKey('casa_reservas'));
    casaReservas = d ? JSON.parse(d) : [];
}
function saveCasaRes() {
    localStorage.setItem(userKey('casa_reservas'), JSON.stringify(casaReservas));
    syncCloudSave();
}

async function startCasaSession() {
    document.getElementById('casaApp').classList.remove('hidden');
    document.getElementById('casaHeaderUserName').textContent = currentUser.name;

    document.getElementById('casaLogoutBtn').onclick = handleLogout;
    document.getElementById('casaSyncBtn').onclick = () => window.manualCloudSync('casaSyncBtn', 'casaSyncTime');

    loadCasaSettings();
    loadCasaReceb();
    loadCasaDesp();
    loadCasaRes();
    await syncCloudLoad();

    document.getElementById('casaRecebData').value = todayISO();
    document.getElementById('casaDespData').value = todayISO();
    document.getElementById('casaResData').value = todayISO();

    populateCasaMonthFilter();
    setupCasaMonthFilter();
    setupCasaTabs();
    setupCasaListeners();
    setupCasaSettingsModal();
    renderCasaApp();

    checkAndRunDailyBackup();
    subscribeRealtime();
}

function populateCasaMonthFilter() {
    const select = document.getElementById('casaMonthFilter');
    if (!select) return;
    const prev = select.value;
    const months = new Set([new Date().toISOString().substring(0, 7)]);
    casaRecebimentos.forEach(e => months.add(monthKey(e.data)));
    casaDespesas.forEach(e => months.add(monthKey(e.data)));
    const sorted = Array.from(months).sort().reverse();
    select.innerHTML = sorted.map(m => {
        const [y, mm] = m.split('-');
        const names = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];
        return `<option value="${m}">${names[parseInt(mm,10)-1]} / ${y}</option>`;
    }).join('');
    if (prev && sorted.includes(prev)) select.value = prev;
}

function setupCasaMonthFilter() {
    const el = document.getElementById('casaMonthFilter');
    if (el) el.onchange = renderCasaApp;
}

function setupCasaTabs() {
    document.querySelectorAll('#casaTabsNav .tab-btn').forEach(btn => {
        btn.onclick = () => {
            document.querySelectorAll('#casaTabsNav .tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('#casaApp .ctab-content').forEach(c => c.classList.remove('active'));
            btn.classList.add('active');
            document.getElementById(btn.dataset.ctab).classList.add('active');
            renderCasaApp();
        };
    });
}

function setupCasaListeners() {
    document.getElementById('casaRecebForm').onsubmit = handleCasaRecebSubmit;
    document.getElementById('casaDespForm').onsubmit = handleCasaDespSubmit;
    document.getElementById('casaResForm').onsubmit = handleCasaResSubmit;

    const cb = document.getElementById('casaDespCategoria');
    if (cb) {
        cb.innerHTML = CASA_CATEGORIAS.map(c => `<option value="${c}">${c}</option>`).join('');
    }

    // Export simples
    const exp = document.getElementById('casaExportCsvBtn');
    if (exp) exp.onclick = exportCasaCSV;
}

function setupCasaSettingsModal() {
    const open = document.getElementById('openCasaSettingsBtn');
    if (!open) return;
    open.onclick = () => {
        document.getElementById('casaBackupEmail').value = casaSettings.backupEmail || '';
        document.getElementById('casaEmailjsServiceId').value = casaSettings.emailjsServiceId || '';
        document.getElementById('casaEmailjsTemplateId').value = casaSettings.emailjsTemplateId || '';
        document.getElementById('casaEmailjsPublicKey').value = casaSettings.emailjsPublicKey || '';
        document.getElementById('casaSettingsModal').classList.remove('hidden');
    };
    const close = () => document.getElementById('casaSettingsModal').classList.add('hidden');
    document.getElementById('closeCasaSettingsBtn').onclick = close;
    document.getElementById('cancelCasaSettingsBtn').onclick = close;
    document.getElementById('casaSettingsForm').onsubmit = (e) => {
        e.preventDefault();
        casaSettings.backupEmail = document.getElementById('casaBackupEmail').value.trim();
        casaSettings.emailjsServiceId = document.getElementById('casaEmailjsServiceId').value.trim();
        casaSettings.emailjsTemplateId = document.getElementById('casaEmailjsTemplateId').value.trim();
        casaSettings.emailjsPublicKey = document.getElementById('casaEmailjsPublicKey').value.trim();
        saveCasaSettings();
        close();
        showToast('Configurações salvas!', 'success');
    };

    const mb = document.getElementById('casaManualBackupBtn');
    if (mb) mb.onclick = () => { downloadJSONBackup(); showToast('Backup JSON baixado!', 'success'); };
    const te = document.getElementById('casaTestEmailBtn');
    if (te) te.onclick = () => sendEmailBackup(true);
    const imp = document.getElementById('casaImportJsonFile');
    if (imp) {
        imp.onchange = (e) => {
            if (e.target.files[0]) restoreJSONBackup(e.target.files[0]);
            e.target.value = '';
        };
    }
    const impCsv = document.getElementById('casaImportCsvFile');
    if (impCsv) {
        impCsv.onchange = (e) => {
            if (e.target.files[0]) {
                if (confirm('Importar dados do CSV? Duplicados serão ignorados.')) {
                    importCasaCSV(e.target.files[0]);
                }
            }
            e.target.value = '';
        };
    }
}

function handleCasaRecebSubmit(e) {
    e.preventDefault();
    const id = document.getElementById('casaRecebId').value || generateId();
    const data = document.getElementById('casaRecebData').value;
    if (!data) return alert('Informe a data.');
    const valor = parseFloat(document.getElementById('casaRecebValor').value) || 0;
    const desc = document.getElementById('casaRecebDesc').value.trim();
    const fonte = document.getElementById('casaRecebFonte').value.trim() || 'Salário';
    const entry = { id, data, valor, descricao: desc, fonte };
    if (editingCasaRecebId) {
        const i = casaRecebimentos.findIndex(x => x.id === editingCasaRecebId);
        if (i !== -1) casaRecebimentos[i] = entry;
    } else {
        casaRecebimentos.push(entry);
    }
    saveCasaReceb();
    editingCasaRecebId = null;
    document.getElementById('casaRecebForm').reset();
    document.getElementById('casaRecebData').value = todayISO();
    document.getElementById('casaSaveRecebBtn').innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Salvar';
    renderCasaApp();
    showToast('Recebimento salvo!', 'success');
}

function handleCasaDespSubmit(e) {
    e.preventDefault();
    const id = document.getElementById('casaDespId').value || generateId();
    const data = document.getElementById('casaDespData').value;
    if (!data) return alert('Informe a data.');
    const valor = parseFloat(document.getElementById('casaDespValor').value) || 0;
    const categoria = document.getElementById('casaDespCategoria').value;
    const desc = document.getElementById('casaDespDesc').value.trim();
    const status = document.getElementById('casaDespStatus').value;
    const entry = { id, data, valor, categoria, descricao: desc, status };
    if (editingCasaDespId) {
        const i = casaDespesas.findIndex(x => x.id === editingCasaDespId);
        if (i !== -1) casaDespesas[i] = entry;
    } else {
        casaDespesas.push(entry);
    }
    saveCasaDesp();
    editingCasaDespId = null;
    document.getElementById('casaDespForm').reset();
    document.getElementById('casaDespData').value = todayISO();
    document.getElementById('casaSaveDespBtn').innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Salvar';
    renderCasaApp();
    showToast('Despesa salva!', 'success');
}

function handleCasaResSubmit(e) {
    e.preventDefault();
    const id = document.getElementById('casaResId').value || generateId();
    const data = document.getElementById('casaResData').value;
    if (!data) return alert('Informe a data.');
    const valor = parseFloat(document.getElementById('casaResValor').value) || 0;
    const tipo = document.getElementById('casaResTipo').value; // 'deposito' (guardar) ou 'retirada' (usar)
    const obs = document.getElementById('casaResObs').value.trim();
    const entry = { id, data, valor, tipo, observacao: obs };
    if (editingCasaResId) {
        const i = casaReservas.findIndex(x => x.id === editingCasaResId);
        if (i !== -1) casaReservas[i] = entry;
    } else {
        casaReservas.push(entry);
    }
    saveCasaRes();
    editingCasaResId = null;
    document.getElementById('casaResForm').reset();
    document.getElementById('casaResData').value = todayISO();
    document.getElementById('casaSaveResBtn').innerHTML = '<i class="fa-solid fa-floppy-disk"></i> Salvar';
    renderCasaApp();
    showToast('Movimentação salva!', 'success');
}

window.editCasaReceb = function(id) {
    const x = casaRecebimentos.find(e => e.id === id);
    if (!x) return;
    editingCasaRecebId = id;
    document.getElementById('casaRecebId').value = x.id;
    document.getElementById('casaRecebData').value = x.data;
    document.getElementById('casaRecebValor').value = x.valor;
    document.getElementById('casaRecebDesc').value = x.descricao || '';
    document.getElementById('casaRecebFonte').value = x.fonte || '';
    document.getElementById('casaSaveRecebBtn').innerHTML = '<i class="fa-solid fa-check"></i> Atualizar';
};

window.deleteCasaReceb = function(id) {
    if (!confirm('Excluir?')) return;
    casaRecebimentos = casaRecebimentos.filter(e => e.id !== id);
    deleteCloudItem('casa_recebimentos', id);
    saveCasaReceb();
    renderCasaApp();
};

window.editCasaDesp = function(id) {
    const x = casaDespesas.find(e => e.id === id);
    if (!x) return;
    editingCasaDespId = id;
    document.getElementById('casaDespId').value = x.id;
    document.getElementById('casaDespData').value = x.data;
    document.getElementById('casaDespCategoria').value = x.categoria;
    document.getElementById('casaDespValor').value = x.valor;
    document.getElementById('casaDespDesc').value = x.descricao || '';
    document.getElementById('casaDespStatus').value = x.status || 'Pago';
    document.getElementById('casaSaveDespBtn').innerHTML = '<i class="fa-solid fa-check"></i> Atualizar';
};

window.deleteCasaDesp = function(id) {
    if (!confirm('Excluir?')) return;
    casaDespesas = casaDespesas.filter(e => e.id !== id);
    deleteCloudItem('casa_despesas', id);
    saveCasaDesp();
    renderCasaApp();
};

window.editCasaRes = function(id) {
    const x = casaReservas.find(e => e.id === id);
    if (!x) return;
    editingCasaResId = id;
    document.getElementById('casaResId').value = x.id;
    document.getElementById('casaResData').value = x.data;
    document.getElementById('casaResValor').value = x.valor;
    document.getElementById('casaResTipo').value = x.tipo;
    document.getElementById('casaResObs').value = x.observacao || '';
    document.getElementById('casaSaveResBtn').innerHTML = '<i class="fa-solid fa-check"></i> Atualizar';
};

window.deleteCasaRes = function(id) {
    if (!confirm('Excluir?')) return;
    casaReservas = casaReservas.filter(e => e.id !== id);
    deleteCloudItem('casa_reservas', id);
    saveCasaRes();
    renderCasaApp();
};

function renderCasaApp() {
    const m = document.getElementById('casaMonthFilter').value;
    const recs = casaRecebimentos.filter(e => monthKey(e.data) === m).sort((a,b) => new Date(a.data)-new Date(b.data));
    const deps = casaDespesas.filter(e => monthKey(e.data) === m).sort((a,b) => new Date(a.data)-new Date(b.data));

    const totalRec = recs.reduce((s,e) => s + (+e.valor||0), 0);
    const totalDep = deps.reduce((s,e) => s + (+e.valor||0), 0);
    const saldoMes = totalRec - totalDep;

    // Reserva total acumulada é a soma de todos os tempos
    let totalRes = 0;
    casaReservas.forEach(r => {
        if (r.tipo === 'deposito') totalRes += (+r.valor||0);
        else totalRes -= (+r.valor||0);
    });

    // KPIs
    const tkpi = document.getElementById('casaKpiRec');
    if (tkpi) tkpi.textContent = fmtR(totalRec);
    const tkpd = document.getElementById('casaKpiDesp');
    if (tkpd) tkpd.textContent = fmtR(totalDep);
    const tks = document.getElementById('casaKpiSaldo');
    if (tks) tks.textContent = fmtR(saldoMes);
    if (tks) tks.className = saldoMes >= 0 ? 'kpi-value text-success' : 'kpi-value text-danger';
    const tkr = document.getElementById('casaKpiReserva');
    if (tkr) tkr.textContent = fmtR(totalRes);

    // Tabela de recebimentos
    const trc = document.getElementById('casaRecebTable');
    if (trc) {
        trc.innerHTML = recs.length === 0 ? '<tr><td colspan="4" class="empty-state">Nenhum recebimento este mês.</td></tr>' : recs.map(item => `
            <tr>
                <td data-label="Data">${dateBR(item.data)}</td>
                <td data-label="Fonte">${item.fonte || '-'}</td>
                <td data-label="Descrição">${item.descricao || '-'}</td>
                <td data-label="Valor" class="text-success"><strong>${fmtR(item.valor)}</strong></td>
                <td data-label="Ações" class="text-center">
                    <button class="action-btn action-edit" title="Editar" onclick="editCasaReceb('${item.id}')"><i class="fa-solid fa-pen"></i></button>
                    <button class="action-btn action-delete" title="Excluir" onclick="deleteCasaReceb('${item.id}')"><i class="fa-solid fa-trash"></i></button>
                </td>
            </tr>`).join('');
    }

    // Tabela de despesas
    const tdp = document.getElementById('casaDespTable');
    if (tdp) {
        tdp.innerHTML = deps.length === 0 ? '<tr><td colspan="5" class="empty-state">Nenhuma despesa este mês.</td></tr>' : deps.map(item => `
            <tr>
                <td data-label="Data">${dateBR(item.data)}</td>
                <td data-label="Categoria"><span class="badge-category">${item.categoria}</span></td>
                <td data-label="Descrição">${item.descricao || '-'}</td>
                <td data-label="Valor" class="text-danger"><strong>${fmtR(item.valor)}</strong></td>
                <td data-label="Status">${item.status === 'Pago' ? '✅' : '⏳'}</td>
                <td data-label="Ações" class="text-center">
                    <button class="action-btn action-edit" title="Editar" onclick="editCasaDesp('${item.id}')"><i class="fa-solid fa-pen"></i></button>
                    <button class="action-btn action-delete" title="Excluir" onclick="deleteCasaDesp('${item.id}')"><i class="fa-solid fa-trash"></i></button>
                </td>
            </tr>`).join('');
    }

    // Tabela de reservas
    const trs = document.getElementById('casaResTable');
    if (trs) {
        trs.innerHTML = casaReservas.length === 0 ? '<tr><td colspan="4" class="empty-state">Nenhuma movimentação na reserva ainda.</td></tr>' : casaReservas.slice(0, 50).map(item => `
            <tr>
                <td data-label="Data">${dateBR(item.data)}</td>
                <td data-label="Tipo">${item.tipo === 'deposito' ? '🟢 Depósito' : '🔴 Retirada'}</td>
                <td data-label="Valor" class="${item.tipo === 'deposito' ? 'text-success' : 'text-danger'}"><strong>${fmtR(item.valor)}</strong></td>
                <td data-label="Observação">${item.observacao || '-'}</td>
                <td data-label="Ações" class="text-center">
                    <button class="action-btn action-edit" title="Editar" onclick="editCasaRes('${item.id}')"><i class="fa-solid fa-pen"></i></button>
                    <button class="action-btn action-delete" title="Excluir" onclick="deleteCasaRes('${item.id}')"><i class="fa-solid fa-trash"></i></button>
                </td>
            </tr>`).join('');
    }

    // Gráfico de pizza por categoria no mês
    const ctx = document.getElementById('casaCatChart');
    if (ctx) {
        if (charts.casaCat) charts.casaCat.destroy();
        const cats = {};
        deps.forEach(e => { cats[e.categoria] = (cats[e.categoria]||0) + (+e.valor||0); });
        charts.casaCat = new Chart(ctx.getContext('2d'), {
            type: 'doughnut',
            data: {
                labels: Object.keys(cats),
                datasets: [{ data: Object.values(cats), backgroundColor: ['#ef4444','#3b82f6','#10b981','#f59e0b','#8b5cf6','#06b6d4','#ec4899','#94a3b8'] }]
            },
            options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right', labels: { color: '#94a3b8' } } } }
        });
    }

    // Comparativo Receitas x Despesas
    const ctxB = document.getElementById('casaCompareChart');
    if (ctxB) {
        if (charts.casaCompare) charts.casaCompare.destroy();
        charts.casaCompare = new Chart(ctxB.getContext('2d'), {
            type: 'bar',
            data: {
                labels: ['Receitas', 'Despesas', 'Sobra'],
                datasets: [{
                    label: 'Valores',
                    data: [totalRec, totalDep, saldoMes],
                    backgroundColor: ['rgba(16,185,129,.7)','rgba(239,68,68,.7)','rgba(59,130,246,.7)'],
                    borderRadius: 8
                }]
            },
            options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { ticks: { color: '#94a3b8' } }, y: { ticks: { color: '#94a3b8' } } } }
        });
    }
}

function exportCasaCSV() {
    let csv = '\uFEFF';
    csv += 'Data;Fonte;Descricao;Valor\n';
    casaRecebimentos.forEach(e => { csv += `${dateBR(e.data)};${e.fonte || ''};"${e.descricao || ''}";${e.valor}\n`; });
    csv += '\nData;Categoria;Descricao;Valor;Status\n';
    casaDespesas.forEach(e => { csv += `${dateBR(e.data)};${e.categoria};"${e.descricao || ''}";${e.valor};${e.status}\n`; });
    csv += '\nData;Tipo;Valor;Observacao\n';
    casaReservas.forEach(e => { csv += `${dateBR(e.data)};${e.tipo};${e.valor};"${e.observacao || ''}"\n`; });
    downloadCSV(csv, 'Controle_Casa.csv');
}

async function importCasaCSV(file) {
    try {
        const text = await readFileAsText(file);
        const sep = detectSeparator(text);
        const lines = text.split('\n').map(l => l.replace(/\r/g, '').replace(/^\uFEFF/, ''));
        let section = '';
        let added = 0;
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;
            if (line.startsWith('Data;')) { section = line.includes('Fonte') ? 'rec' : 'dep'; continue; }
            if (line.startsWith('Data;Tipo')) { section = 'res'; continue; }
            if (line.startsWith('TOTAL') || line.startsWith('Data;')) continue;
            const cols = parseCSVLine(line, sep);
            if (section === 'rec' && cols.length >= 4) {
                const data = parseDateBR(cols[0]);
                if (!data) continue;
                const valor = parseFloat(cols[3]) || 0;
                if (!casaRecebimentos.find(x => x.data === data && x.valor === valor && x.fonte === cols[1])) {
                    casaRecebimentos.push({ id: generateId(), data, fonte: cols[1] || '', descricao: (cols[2]||'').replace(/"/g,''), valor });
                    added++;
                }
            } else if (section === 'dep' && cols.length >= 4) {
                const data = parseDateBR(cols[0]);
                if (!data) continue;
                const valor = parseFloat(cols[3]) || 0;
                if (!casaDespesas.find(x => x.data === data && x.valor === valor && x.categoria === cols[1])) {
                    casaDespesas.push({ id: generateId(), data, categoria: cols[1] || 'Outros', descricao: (cols[2]||'').replace(/"/g,''), valor, status: cols[4] || 'Pago' });
                    added++;
                }
            } else if (section === 'res' && cols.length >= 3) {
                const data = parseDateBR(cols[0]);
                if (!data) continue;
                const valor = parseFloat(cols[2]) || 0;
                if (!casaReservas.find(x => x.data === data && x.valor === valor && x.tipo === cols[1])) {
                    casaReservas.push({ id: generateId(), data, tipo: cols[1], valor, observacao: (cols[3]||'').replace(/"/g,'') });
                    added++;
                }
            }
        }
        if (added > 0) {
            saveCasaReceb();
            saveCasaDesp();
            saveCasaRes();
            populateCasaMonthFilter();
            renderCasaApp();
            showToast(`Importado: ${added} registro(s) de casa.`, 'success');
        } else {
            showToast('Nenhum dado novo no CSV.', 'warning');
        }
    } catch(err) {
        showToast('Erro na importação: ' + err.message, 'error');
    }
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
        papel: ['Couchê 90g', 'Couchê 150g'],
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
        papel: ['Couchê 250g', 'Couchê 300g'],
        tamanhos: ['9x5cm'],
        cores: ['4x0', '4x1', '4x4'],
        tiragens: [1000, 3000, 5000, 10000],
        calcPrice: (tamanho, papel, cor, tiragem) => {
            const cBase = cor === '4x4' ? 1.5 : (cor === '4x1' ? 1.2 : 1);
            const tiragemBase = { 1000: 45, 3000: 90, 5000: 150, 10000: 250 };
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
        tamanhos: ['9x5cm'],
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
    let costCalc = 0;
    if (pdvCurrentProduct.group === 'A') {
        const key = `${pdvCurrentProduct.id}_${pdvCurrentConfig.tamanho}_${pdvCurrentConfig.papel}_${pdvCurrentConfig.cor}_${pdvCurrentConfig.tiragem}`;
        const defaultCalc = pdvCurrentProduct.calcPrice(pdvCurrentConfig.tamanho, pdvCurrentConfig.papel, pdvCurrentConfig.cor, pdvCurrentConfig.tiragem);
        const defaultCost = defaultCalc * 0.4;
        calc = getPriceFor(key, defaultCalc);
        costCalc = getCostFor(key, defaultCost);
    } 
    else if (pdvCurrentProduct.group === 'B') {
        const key = `${pdvCurrentProduct.id}_${pdvCurrentConfig.tamanho}_${pdvCurrentConfig.papel}_${pdvCurrentConfig.cor}`;
        const cBase = pdvCurrentProduct.baseCores ? pdvCurrentProduct.baseCores[pdvCurrentConfig.cor] : 1;
        const pBase = pdvCurrentProduct.basePrecoUnidade || 1;
        const defaultUnitPrice = cBase * pBase;
        const defaultUnitCost = defaultUnitPrice * 0.4;
        
        const unitPrice = getPriceFor(key, defaultUnitPrice);
        const unitCost = getCostFor(key, defaultUnitCost);
        calc = unitPrice * pdvCurrentConfig.qtd;
        costCalc = unitCost * pdvCurrentConfig.qtd;
    } 
    else if (pdvCurrentProduct.group === 'C') {
        const key = `${pdvCurrentProduct.id}_${pdvCurrentConfig.papel}`;
        const defaultM2Price = pdvCurrentProduct.precoM2 || 45;
        const defaultM2Cost = defaultM2Price * 0.4;
        const m2Price = getPriceFor(key, defaultM2Price);
        const m2Cost = getCostFor(key, defaultM2Cost);
        
        calc = (pdvCurrentConfig.largura * pdvCurrentConfig.altura) * m2Price * pdvCurrentConfig.qtd;
        costCalc = (pdvCurrentConfig.largura * pdvCurrentConfig.altura) * m2Cost * pdvCurrentConfig.qtd;
    }
    
    pdvCurrentSubtotal = calc;
    pdvCurrentCost = costCalc;
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
        custoTotal: pdvCurrentCost,
        precoTotal: pdvCurrentSubtotal,
        lucro: pdvCurrentSubtotal - pdvCurrentCost
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
    const sinalInput = parseFloat(document.getElementById('summarySinal').value) || 0;
    
    const total = Math.max(0, subtotal - discountInput);
    const faltaPagar = Math.max(0, total - sinalInput);

    const elSubtotal = document.getElementById('summarySubtotal');
    if (elSubtotal) elSubtotal.innerText = fmtR(subtotal);
    
    const elTotalPedido = document.getElementById('summaryTotalPedido');
    if (elTotalPedido) elTotalPedido.innerText = fmtR(total);
    
    const elTotal = document.getElementById('summaryTotal');
    if (elTotal) {
        // Se a pagina antiga estiver cacheada (sem summaryTotalPedido), summaryTotal deve ser o total.
        // Se a nova estiver carregada, summaryTotal  o Falta Pagar.
        elTotal.innerText = elTotalPedido ? fmtR(faltaPagar) : fmtR(total);
    }
    
    const elFaltaPagarOld = document.getElementById('summaryFaltaPagar');
    if (elFaltaPagarOld) elFaltaPagarOld.innerText = fmtR(faltaPagar);
};

window.finalizeSale = function() {
    if (graficaCart.length === 0) {
        showToast('O carrinho está vazio.', 'warning');
        return;
    }

    const cliente = document.getElementById('clientName').value.trim();
    const telefone = document.getElementById('clientPhone').value.trim();
    
    if (!cliente || !telefone) {
        showToast('Nome do cliente e celular são obrigatórios!', 'error');
        return;
    }

    const formaPagamento = document.getElementById('paymentMethod').value;
    const orderStatus = document.getElementById('orderStatus').value;
    const desconto = parseFloat(document.getElementById('summaryDiscount').value) || 0;
    const sinal = parseFloat(document.getElementById('summarySinal').value) || 0;
    
    const dataVenda = todayISO();
    
    // Distribui o desconto e sinal proporcionalmente para não quebrar o DRE ou relatórios individuais
    const subtotalGeral = graficaCart.reduce((acc, curr) => acc + curr.precoTotal, 0);
    const taxaDesconto = subtotalGeral > 0 ? (desconto / subtotalGeral) : 0;
    const taxaSinal = subtotalGeral > 0 ? (sinal / subtotalGeral) : 0;

    graficaCart.forEach(item => {
        const precoComDesconto = item.precoTotal - (item.precoTotal * taxaDesconto);
        const sinalItem = subtotalGeral > 0 ? (precoComDesconto * (sinal / (subtotalGeral - desconto))) : 0;
        const lucroFinal = precoComDesconto - item.custoTotal;
        
        const venda = {
            id: generateId(), 
            data: dataVenda,
            cliente,
            telefone,
            tipoItem: item.categoria,
            produtoId: item.produtoId,
            detalhes: item.detalhes,
            m2Total: item.m2Total,
            qtd: item.qtd,
            custoTotal: item.custoTotal,
            precoTotal: precoComDesconto,
            sinal: isNaN(sinalItem) ? 0 : sinalItem,
            faltaPagar: isNaN(precoComDesconto - sinalItem) ? 0 : (precoComDesconto - sinalItem),
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
    document.getElementById('clientPhone').value = '';
    document.getElementById('summaryDiscount').value = 0;
    document.getElementById('summarySinal').value = 0;
    renderGraficaCart();
    renderGraficaApp();
};


// ----- Forms Setup -----
function setupGraficaForms() {
    // Forms para produtos antigos foram substituídos pela nova Tabela de Precificação.

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
        const id = document.getElementById('graficaDespesaOpId').value || generateId();
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
        const id = document.getElementById('graficaPessoalId').value || generateId();
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

    const gManual = document.getElementById('gManualBackupBtn');
    if (gManual) gManual.onclick = () => {
        downloadJSONBackup();
        showToast('Backup JSON baixado com sucesso!', 'success');
    };
    const gTest = document.getElementById('gTestEmailBtn');
    if (gTest) gTest.onclick = () => sendEmailBackup(true);

    const gImport = document.getElementById('graficaImportJsonFile');
    if (gImport) {
        gImport.onchange = (e) => {
            if (e.target.files[0]) restoreJSONBackup(e.target.files[0]);
            e.target.value = '';
        };
    }
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
        tbody.innerHTML = emptyRow(11, 'Nenhum pedido ou venda no período.');
        return;
    }

    tbody.innerHTML = filtered.map(v => {
        const st = v.status || 'Entregue';
        const faltaPagar = (v.faltaPagar !== undefined) ? v.faltaPagar : v.precoTotal;
        const isPago = faltaPagar <= 0.01;

        // Cor da linha baseada no pagamento
        const rowStyle = isPago
            ? 'border-left: 3px solid #16a34a; background: rgba(22,163,74,0.06);'
            : 'border-left: 3px solid #dc2626; background: rgba(220,38,38,0.06);';

        const faltaDisplay = isPago
            ? `<span style="color:#4ade80; font-weight:700;">✓ Pago</span>`
            : `<span style="color:#f87171; font-weight:700;">${fmtR(faltaPagar)}</span>`;

        const sinalDisplay = v.sinal > 0 ? fmtR(v.sinal) : `<span class="text-slate-500">—</span>`;

        return `
        <tr style="${rowStyle}">
            <td data-label="Data">${dateBR(v.data)}</td>
            <td data-label="Cliente">
                <strong>${v.cliente || 'Balcão'}</strong>
                ${v.telefone ? `<br><span style="font-size:0.72rem;color:#94a3b8;"><i class="fa-solid fa-phone" style="font-size:0.65rem;"></i> ${v.telefone}</span>` : ''}
            </td>
            <td data-label="Tipo"><span class="badge ${v.tipoItem && v.tipoItem.includes('Produto') ? 'badge-success' : 'badge-primary'}">${v.tipoItem}</span></td>
            <td data-label="Item / Serviço" style="max-width:200px;font-size:0.8rem;">${v.detalhes} | <strong>Qtd: ${v.qtd}</strong>${v.m2Total ? ` (${v.m2Total.toFixed(2)} m²)` : ''}</td>
            <td data-label="Preço Total"><strong>${fmtR(v.precoTotal)}</strong></td>
            <td data-label="Sinal Pago">${sinalDisplay}</td>
            <td data-label="Falta Pagar">${faltaDisplay}</td>
            <td data-label="Lucro" class="text-success"><strong>+${fmtR(v.lucro)}</strong></td>
            <td data-label="Pagamento"><span class="badge badge-secondary">${v.formaPagamento || 'PIX'}</span></td>
            <td data-label="Status">
                <select class="form-control" style="width:auto; display:inline-block; font-size:0.75rem;" onchange="changeGraficaVendaStatus('${v.id}', this.value)">
                    <option value="Pendente Aprovação" ${st === 'Pendente Aprovação' ? 'selected' : ''}>⏳ P. Aprovação</option>
                    <option value="Pendente Entrega" ${st === 'Pendente Entrega' ? 'selected' : ''}>📦 P. Entrega</option>
                    <option value="Entregue" ${st === 'Entregue' ? 'selected' : ''}>✅ Entregue</option>
                </select>
            </td>
            <td data-label="Ações">
                <div class="actions-container">
                    <button class="action-btn action-edit" onclick="viewOrderDetails('${v.id}')" title="Ver Detalhes"><i class="fa-solid fa-eye"></i></button>
                    <button class="action-btn action-delete" onclick="deleteGraficaVenda('${v.id}')" title="Excluir Venda"><i class="fa-solid fa-trash"></i></button>
                </div>
            </td>
        </tr>
    `}).join('');
}

window.viewOrderDetails = function(id) {
    const v = graficaVendas.find(x => x.id === id);
    if (!v) return;
    
    const faltaPagar = (v.faltaPagar !== undefined) ? v.faltaPagar : v.precoTotal;
    const isPago = faltaPagar <= 0.01;

    const content = document.getElementById('graficaOrderModalContent');
    content.innerHTML = `
        <div class="space-y-3 text-slate-300">
            <div style="display:flex; justify-content:space-between; align-items:center;">
                <span class="badge ${v.status === 'Pendente Aprovação' ? 'badge-warning' : (v.status === 'Pendente Entrega' ? 'badge-info' : 'badge-success')}">${v.status || 'Entregue'}</span>
                <span style="font-size:0.75rem; color:#64748b;">#${v.id.slice(-8)}</span>
            </div>

            <div style="background:#1e293b; border-radius:8px; padding:12px;">
                <p style="font-size:0.75rem; color:#64748b; margin:0 0 4px;">CLIENTE</p>
                <p style="margin:0; font-weight:700; color:#f1f5f9;">${v.cliente || 'Balcão'}</p>
                ${v.telefone ? `<p style="margin:4px 0 0; font-size:0.82rem; color:#94a3b8;"><i class="fa-solid fa-phone" style="font-size:0.7rem;"></i> ${v.telefone}</p>` : ''}
            </div>

            <div style="background:#1e293b; border-radius:8px; padding:12px;">
                <p style="font-size:0.75rem; color:#64748b; margin:0 0 6px;">PEDIDO — ${dateBR(v.data)}</p>
                <p style="margin:0 0 2px;"><strong>${v.tipoItem}</strong></p>
                <p style="margin:0; font-size:0.85rem; color:#94a3b8;">${v.detalhes} | Qtd: ${v.qtd}${v.m2Total ? ` (${v.m2Total.toFixed(2)} m²)` : ''}</p>
                ${v.obs ? `<p style="margin:6px 0 0; font-size:0.82rem; color:#fbbf24;"><i class="fa-solid fa-comment-dots"></i> ${v.obs}</p>` : ''}
            </div>

            <div style="background:#1e293b; border-radius:8px; padding:12px;">
                <p style="font-size:0.75rem; color:#64748b; margin:0 0 8px;">FINANCEIRO</p>
                <div style="display:flex; justify-content:space-between; margin-bottom:4px;">
                    <span>Preço Total</span><span style="font-weight:700; color:#f1f5f9;">${fmtR(v.precoTotal)}</span>
                </div>
                <div style="display:flex; justify-content:space-between; margin-bottom:4px;">
                    <span>Sinal Pago</span><span style="color:#a3e635;">${fmtR(v.sinal || 0)}</span>
                </div>
                <div style="display:flex; justify-content:space-between; padding-top:6px; border-top:1px solid #334155; margin-top:4px;">
                    <span style="font-weight:700;">Falta Pagar</span>
                    <span id="modalFaltaDisplay" style="font-weight:700; color:${isPago ? '#4ade80' : '#f87171'};">${isPago ? '✓ Pago' : fmtR(faltaPagar)}</span>
                </div>
                <div style="display:flex; justify-content:space-between; margin-top:4px;">
                    <span>Lucro</span><span style="color:#4ade80;">+${fmtR(v.lucro)}</span>
                </div>
                <div style="display:flex; justify-content:space-between; margin-top:4px;">
                    <span>Forma de Pagamento</span><span class="badge badge-secondary">${v.formaPagamento || 'PIX'}</span>
                </div>
            </div>

            ${!isPago ? `
            <div style="background:rgba(220,38,38,0.1); border:1px solid rgba(220,38,38,0.3); border-radius:8px; padding:14px;">
                <p style="font-size:0.8rem; color:#fca5a5; margin:0 0 10px; font-weight:600;">
                    <i class="fa-solid fa-circle-dollar-to-slot mr-2"></i>Registrar Pagamento
                </p>
                <div style="display:flex; gap:8px; align-items:center; margin-bottom:10px; flex-wrap:wrap;">
                    <span style="font-size:0.8rem; white-space:nowrap; color:#94a3b8;">Valor recebido (R$)</span>
                    <input type="number" id="modalPagamentoValor" step="0.01" min="0" 
                           value="${faltaPagar.toFixed(2)}"
                           style="flex:1; min-width:120px; max-width:100%; background:#0f172a; border:1px solid #475569; border-radius:6px; padding:6px 8px; color:#f1f5f9; font-size:0.9rem; text-align:right; outline:none; box-sizing:border-box;">
                </div>
                <div style="display:flex; gap:8px; flex-wrap:wrap;">
                    <button onclick="markOrderPaid('${v.id}', false)" 
                            style="flex:1; min-width:130px; padding:9px; background:#1d4ed8; color:#fff; border:none; border-radius:8px; font-weight:700; cursor:pointer; font-size:0.85rem; transition:0.2s;"
                            onmouseover="this.style.background='#2563eb'" onmouseout="this.style.background='#1d4ed8'">
                        <i class="fa-solid fa-money-bill-wave mr-1"></i>Registrar Parcial
                    </button>
                    <button onclick="markOrderPaid('${v.id}', true)" 
                            style="flex:1; min-width:130px; padding:9px; background:#15803d; color:#fff; border:none; border-radius:8px; font-weight:700; cursor:pointer; font-size:0.85rem; transition:0.2s;"
                            onmouseover="this.style.background='#16a34a'" onmouseout="this.style.background='#15803d'">
                        <i class="fa-solid fa-check-circle mr-1"></i>Pago Total
                    </button>
                </div>
            </div>` : `
            <div style="background:rgba(22,163,74,0.1); border:1px solid rgba(22,163,74,0.3); border-radius:8px; padding:12px; text-align:center;">
                <i class="fa-solid fa-circle-check" style="color:#4ade80; font-size:1.5rem; display:block; margin-bottom:6px;"></i>
                <p style="color:#4ade80; font-weight:700; margin:0;">Pedido totalmente pago!</p>
            </div>`}
        </div>
    `;
    
    document.getElementById('graficaOrderModal').classList.remove('hidden');
};

window.markOrderPaid = function(id, fullPay) {
    const v = graficaVendas.find(x => x.id === id);
    if (!v) return;

    if (fullPay) {
        v.sinal = v.precoTotal;
        v.faltaPagar = 0;
        v.status = 'Entregue';
        showToast('Pedido marcado como PAGO!', 'success');
    } else {
        const val = parseFloat(document.getElementById('modalPagamentoValor').value) || 0;
        const faltaAtual = (v.faltaPagar !== undefined) ? v.faltaPagar : v.precoTotal;
        const novoSinal = (v.sinal || 0) + val;
        const novaFalta = Math.max(0, faltaAtual - val);
        v.sinal = novoSinal;
        v.faltaPagar = novaFalta;
        if (novaFalta <= 0.01) {
            v.status = 'Entregue';
            showToast('Pagamento registrado! Pedido quitado.', 'success');
        } else {
            showToast(`Pagamento parcial de ${fmtR(val)} registrado. Falta: ${fmtR(novaFalta)}`, 'info');
        }
    }

    saveGraficaVendas();
    // Atualiza tabela, DRE, KPIs e saldo disponível de uma vez
    renderGraficaApp();
    // Reopen modal with updated data
    window.viewOrderDetails(id);
};


window.closeGraficaOrderModal = function() {
    document.getElementById('graficaOrderModal').classList.add('hidden');
};

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
            <td data-label="Data">${dateBR(d.data)}</td>
            <td data-label="Categoria"><span class="badge badge-secondary">${d.categoria}</span></td>
            <td data-label="Descrição / Fornecedor"><strong>${d.descricao}</strong></td>
            <td class="text-danger" data-label="Valor"><strong>${fmtR(d.valor)}</strong></td>
            <td data-label="Status">
                <span class="badge ${d.status === 'Pago' ? 'badge-success' : 'badge-danger'}">${d.status}</span>
            </td>
            <td data-label="Ações">
                <div class="actions-container">
                    <button class="action-btn action-edit" onclick="editGraficaDespesaOp('${d.id}')" title="Editar"><i class="fa-solid fa-pen"></i></button>
                    <button class="action-btn action-delete" onclick="deleteGraficaDespesaOp('${d.id}')" title="Excluir"><i class="fa-solid fa-trash"></i></button>
                </div>
            </td>
        </tr>
    `).join('');
}

function renderGraficaDRE() {
    const m = document.getElementById('graficaMonthFilter').value;

    const vendasMes = graficaVendas.filter(e => monthKey(e.data) === m);
    const despesasOpMes = graficaDespesasOp.filter(e => monthKey(e.data) === m);
    const despesasPessoaisMes = graficaDespesasPessoais.filter(e => monthKey(e.vencimento) === m);

    // Receita = valor efetivamente recebido (descontando o que ainda falta pagar)
    const receitaBruta = vendasMes.reduce((acc, v) => {
        const falta = (v.faltaPagar !== undefined) ? v.faltaPagar : 0;
        return acc + Math.max(0, (v.precoTotal || 0) - falta);
    }, 0);
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
    elLiquido.className = lucroLiquido >= 0 ? 'text-success text-lg font-bold' : 'text-danger text-lg font-bold';

    document.getElementById('dreMargemLiquida').textContent = `${margemLiquida.toFixed(1)}%`;
    document.getElementById('dreRetiradasPessoais').textContent = fmtR(retiradasPessoais);

    const elSaldo = document.getElementById('dreSaldoFinal');
    if (elSaldo) {
        elSaldo.textContent = fmtR(saldoFinal);
        elSaldo.className = saldoFinal >= 0 ? 'text-success text-xl font-bold' : 'text-danger text-xl font-bold';
    }

    // Atualiza KPIs espelhados na aba "Gastos de Casa"
    const elSaldoKpi = document.getElementById('kpiSaldoDisponivelGrafica');
    if (elSaldoKpi) {
        elSaldoKpi.textContent = fmtR(lucroLiquido);
        elSaldoKpi.style.color = lucroLiquido >= 0 ? 'var(--brand-400)' : '#f87171';
    }
    const elSaldoFinalKpi = document.getElementById('kpiSaldoFinalLivre');
    if (elSaldoFinalKpi) {
        elSaldoFinalKpi.textContent = fmtR(saldoFinal);
        elSaldoFinalKpi.style.color = saldoFinal >= 0 ? '#34d399' : '#f87171';
    }
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
            <td data-label="Vencimento">${dateBR(d.vencimento)}</td>
            <td data-label="Pagamento">${d.pagamento ? dateBR(d.pagamento) : '-'}</td>
            <td data-label="Categoria"><span class="badge badge-secondary">${d.categoria}</span></td>
            <td data-label="Descrição"><strong>${d.descricao}</strong></td>
            <td class="text-danger" data-label="Valor"><strong>${fmtR(d.valor)}</strong></td>
            <td data-label="Status">
                <span class="badge ${d.status === 'Pago' ? 'badge-success' : 'badge-danger'}">${d.status}</span>
            </td>
            <td data-label="Ações">
                <div class="actions-container">
                    <button class="action-btn action-edit" onclick="editGraficaDespesaPessoal('${d.id}')" title="Editar"><i class="fa-solid fa-pen"></i></button>
                    <button class="action-btn action-delete" onclick="deleteGraficaDespesaPessoal('${d.id}')" title="Excluir"><i class="fa-solid fa-trash"></i></button>
                </div>
            </td>
        </tr>
    `).join('');
}

function updateGraficaKpis() {
    const m = document.getElementById('graficaMonthFilter').value;
    const setEl = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };

    // Tab Produtos KPIs
    setEl('kpiGraficaTotalProdutos', graficaProdutos.length);
    setEl('kpiGraficaTiposCount', `${graficaProdutos.length} itens no catálogo`);

    const alertasCount = graficaProdutos.filter(p => p.qtdEstoque <= (p.estoqueMinimo || 5)).length;
    setEl('kpiGraficaAlertasEstoque', alertasCount);

    const custoEstoqueTotal = graficaProdutos.reduce((acc, p) => acc + (p.custoUnitario * p.qtdEstoque), 0);
    const vendaEstoqueTotal = graficaProdutos.reduce((acc, p) => acc + (p.precoVenda * p.qtdEstoque), 0);
    setEl('kpiGraficaEstoqueCusto', fmtR(custoEstoqueTotal));
    setEl('kpiGraficaEstoqueVenda', `Potencial Venda: ${fmtR(vendaEstoqueTotal)}`);

    // Tab Despesas Op KPIs
    const despesasOpMes = graficaDespesasOp.filter(e => monthKey(e.data) === m);
    const totalOp = despesasOpMes.reduce((acc, d) => acc + d.valor, 0);
    const pagasOp = despesasOpMes.filter(d => d.status === 'Pago').reduce((acc, d) => acc + d.valor, 0);
    const pendentesOp = despesasOpMes.filter(d => d.status === 'Pendente').reduce((acc, d) => acc + d.valor, 0);

    setEl('kpiGraficaDespesasOpTotal', fmtR(totalOp));
    setEl('kpiGraficaDespesasOpCount', `${despesasOpMes.length} registros em ${m}`);
    setEl('kpiGraficaDespesasOpPagas', fmtR(pagasOp));
    setEl('kpiGraficaDespesasOpPendentes', fmtR(pendentesOp));

    // Tab Pessoal KPIs
    const despesasPessoaisMes = graficaDespesasPessoais.filter(e => monthKey(e.vencimento) === m);
    const totalPess = despesasPessoaisMes.reduce((acc, d) => acc + d.valor, 0);
    const pagasPess = despesasPessoaisMes.filter(d => d.status === 'Pago').reduce((acc, d) => acc + d.valor, 0);
    const pendentesPess = despesasPessoaisMes.filter(d => d.status === 'Pendente').reduce((acc, d) => acc + d.valor, 0);

    setEl('kpiGraficaPessoalTotal', fmtR(totalPess));
    setEl('kpiGraficaPessoalPagas', fmtR(pagasPess));
    setEl('kpiGraficaPessoalPendentes', fmtR(pendentesPess));
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
    if (document.getElementById('graficaDespesaOpFormWrapper').scrollIntoView) {
        document.getElementById('graficaDespesaOpFormWrapper').scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
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
    if (document.getElementById('graficaPessoalFormWrapper').scrollIntoView) {
        document.getElementById('graficaPessoalFormWrapper').scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
};

window.deleteGraficaDespesaPessoal = function(id) {
    if (!confirm('Excluir esta despesa pessoal?')) return;
    graficaDespesasPessoais = graficaDespesasPessoais.filter(d => d.id !== id);
    deleteCloudItem('grafica_despesas_pessoais', id);
    saveGraficaDespesasPessoais();
    renderGraficaApp();
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

function getCostFor(key, defaultCost) {
    if (graficaCosts[key] !== undefined) {
        return graficaCosts[key];
    }
    return defaultCost;
}

window.onPriceChange = function(key, el) {
    const val = parseFloat(el.value);
    if (!isNaN(val)) {
        graficaPrices[key] = val;
    } else {
        delete graficaPrices[key];
    }
}

window.onCostChange = function(key, el) {
    const val = parseFloat(el.value);
    if (!isNaN(val)) {
        graficaCosts[key] = val;
    } else {
        delete graficaCosts[key];
    }
}

window.resetPricesToDefault = function() {
    if (confirm('Tem certeza que deseja apagar todos os preços e custos personalizados e voltar às fórmulas automáticas padrão?')) {
        graficaPrices = {};
        graficaCosts = {};
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
    const tamanhosArr = prod.tamanhos || [];
    const papelArr = prod.papel || [];
    const coresArr = prod.cores || [];
    const tiragensArr = prod.tiragens || [];
    
    tamanhosArr.forEach(tamanho => {
        papelArr.forEach(papel => {
            coresArr.forEach(cor => {
                tiragensArr.forEach(tiragem => {
                    const defaultPrice = prod.calcPrice(tamanho, papel, cor, tiragem);
                    const defaultCost = defaultPrice * 0.4;
                    const key = `${prod.id}_${tamanho}_${papel}_${cor}_${tiragem}`;
                    const currentPrice = getPriceFor(key, defaultPrice);
                    const currentCost = getCostFor(key, defaultCost);
                    
                    html += `
                        <tr class="hover:bg-slate-800 transition">
                            <td class="p-3 text-slate-300" data-label="Tamanho">${tamanho}</td>
                            <td class="p-3 text-slate-300" data-label="Papel">${papel}</td>
                            <td class="p-3 text-slate-300" data-label="Cor">${cor}</td>
                            <td class="p-3 text-slate-300 font-medium" data-label="Tiragem">${tiragem.toLocaleString('pt-BR')} un</td>
                            <td class="p-3 text-right" data-label="Custo (R$)">
                                <div class="flex justify-end items-center">
                                    <span class="text-slate-500 mr-2">R$</span>
                                    <input type="number" step="0.01" value="${currentCost.toFixed(2)}" 
                                           onchange="onCostChange('${key}', this)"
                                           class="w-24 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-slate-300 text-right focus:border-brand-500 focus:outline-none">
                                </div>
                            </td>
                            <td class="p-3 text-right" data-label="Preço Venda (R$)">
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
        const tamanhosArr = prod.tamanhos || [];
        const papelArr = prod.papel || [];
        const coresArr = prod.cores || [];
        
        tamanhosArr.forEach(tamanho => {
            papelArr.forEach(papel => {
                coresArr.forEach(cor => {
                    const defaultPrice = prod.calcPrice(tamanho, papel, cor, 1);
                    const defaultCost = defaultPrice * 0.4;
                    const key = `${prod.id}_${tamanho}_${papel}_${cor}`;
                    const currentPrice = getPriceFor(key, defaultPrice);
                    const currentCost = getCostFor(key, defaultCost);
                    
                    html += `
                        <tr class="hover:bg-slate-800 transition">
                            <td class="p-3 font-medium text-brand-400" data-label="Produto">${prod.nome || prod.name}</td>
                            <td class="p-3 text-slate-300" data-label="Material / Tamanho">${papel} - ${tamanho}</td>
                            <td class="p-3 text-slate-300" data-label="Cor">${cor}</td>
                            <td class="p-3 text-right" data-label="Custo Unit. (R$)">
                                <div class="flex justify-end items-center">
                                    <span class="text-slate-500 mr-2">R$</span>
                                    <input type="number" step="0.01" value="${currentCost.toFixed(2)}" 
                                           onchange="onCostChange('${key}', this)"
                                           class="w-24 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-slate-300 text-right focus:border-brand-500 focus:outline-none">
                                </div>
                            </td>
                            <td class="p-3 text-right" data-label="Preço Unit. (R$)">
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
        const papelArr = prod.papel || [];
        papelArr.forEach(papel => {
            const defaultPrice = prod.calcPrice(100, 100, prod.precoM2 || 45, 1);
            const defaultCost = defaultPrice * 0.4;
            const key = `${prod.id}_${papel}`;
            const currentPrice = getPriceFor(key, defaultPrice);
            const currentCost = getCostFor(key, defaultCost);
            
            html += `
                <tr class="hover:bg-slate-800 transition">
                    <td class="p-3 font-medium text-brand-400" data-label="Material / Mídia">${papel}</td>
                    <td class="p-3 text-slate-300" data-label="Categoria">${prod.nome || prod.name}</td>
                    <td class="p-3 text-right" data-label="Custo M² (R$)">
                        <div class="flex justify-end items-center">
                            <span class="text-slate-500 mr-2">R$</span>
                            <input type="number" step="0.01" value="${currentCost.toFixed(2)}" 
                                   onchange="onCostChange('${key}', this)"
                                   class="w-24 bg-slate-900 border border-slate-700 rounded px-2 py-1 text-slate-300 text-right focus:border-brand-500 focus:outline-none">
                        </div>
                    </td>
                    <td class="p-3 text-right" data-label="Preço por M² (R$)">
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
};

/* =====================================================
   MENU MOBILE (Hambúrguer) — todos os apps
   ===================================================== */
(function initMobileMenus() {
    document.querySelectorAll('.menu-toggle-btn').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
            e.stopPropagation();
            const header = btn.closest('.app-header-container');
            if (!header) return;
            const actions = header.querySelector('.header-actions, .top-actions');
            if (!actions) return;
            const wasOpen = actions.classList.contains('menu-open');
            document.querySelectorAll('.header-actions.menu-open, .top-actions.menu-open').forEach(function(m) { m.classList.remove('menu-open'); });
            if (!wasOpen) actions.classList.add('menu-open');
        });
    });
    document.addEventListener('click', function(e) {
        if (!e.target.closest('.header-actions') && !e.target.closest('.top-actions') && !e.target.closest('.menu-toggle-btn')) {
            document.querySelectorAll('.header-actions.menu-open, .top-actions.menu-open').forEach(function(m) { m.classList.remove('menu-open'); });
        }
    });
    document.querySelectorAll('.header-actions .btn, .top-actions .btn').forEach(function(b) {
        b.addEventListener('click', function() {
            const menu = b.closest('.header-actions, .top-actions');
            if (menu) menu.classList.remove('menu-open');
        });
    });
})();
