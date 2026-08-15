with open('index.html', 'r', encoding='utf-8') as f:
    c = f.read()

old = '''    <!-- TAB 2: Histórico de Vendas e Pedidos (Aba Separada) -->
    <div id="gtab-vendas-historico" class="gtab-content" style="display: none;">
        <section class="card-box" style="margin-top:0">
            <div class="card-header table-header-flex">
                <div>
                    <h3><i class="fa-solid fa-list-check"></i> Histórico de Pedidos &amp; Vendas da Gráfica</h3>
                    <p class="section-desc">Registro completo de todos os serviços e produtos vendidos no período selecionado.</p>
                </div>
            </div>
            <div class="table-responsive">
                <table class="data-table">
                    <thead>
                        <tr>
                            <th>Data</th>
                            <th>Cliente</th>
                            <th>Item / Serviço</th>
                            <th>Detalhes / Qtd</th>
                            <th>Custo Total</th>
                            <th>Preço Total</th>
                            <th>Lucro (R$)</th>
                            <th>Pagamento</th>
                            <th>Status</th>
                            <th>Ações</th>
                        </tr>
                    </thead>
                    <tbody id="graficaVendasTableBody">
                        <!-- Populated by JS -->
                    </tbody>
                </table>
            </div>
        </section>
    </div>'''

new = '''    <!-- TAB 2: Histórico de Vendas e Pedidos (Aba Separada) -->
    <div id="gtab-vendas-historico" class="gtab-content" style="display: none; flex-direction: column;">
        <section class="card-box" style="margin-top:0; flex:1; display:flex; flex-direction:column; overflow:hidden;">
            <div class="card-header table-header-flex" style="flex-shrink:0;">
                <div>
                    <h3><i class="fa-solid fa-list-check"></i> Histórico de Pedidos &amp; Vendas da Gráfica</h3>
                    <p class="section-desc">Registro completo de todos os serviços e produtos vendidos no período selecionado.</p>
                </div>
                <div style="display:flex; gap:16px; align-items:center; font-size:0.8rem; color:#94a3b8;">
                    <span style="display:flex;align-items:center;gap:6px;"><span style="width:12px;height:12px;border-radius:3px;background:#16a34a;display:inline-block;"></span> Pago</span>
                    <span style="display:flex;align-items:center;gap:6px;"><span style="width:12px;height:12px;border-radius:3px;background:#dc2626;display:inline-block;"></span> Falta Pagar</span>
                </div>
            </div>
            <div class="table-responsive" style="flex:1; overflow-y:auto;">
                <table class="data-table" style="width:100%;">
                    <thead style="position:sticky;top:0;z-index:2;">
                        <tr>
                            <th>Data</th>
                            <th>Cliente</th>
                            <th>Item / Serviço</th>
                            <th>Detalhes / Qtd</th>
                            <th>Preço Total</th>
                            <th>Sinal Pago</th>
                            <th>Falta Pagar</th>
                            <th>Lucro (R$)</th>
                            <th>Pagamento</th>
                            <th>Status</th>
                            <th>Ações</th>
                        </tr>
                    </thead>
                    <tbody id="graficaVendasTableBody">
                        <!-- Populated by JS -->
                    </tbody>
                </table>
            </div>
        </section>
    </div>'''

if old in c:
    c = c.replace(old, new, 1)
    print("PATCHED OK")
else:
    print("NOT FOUND - trying CRLF...")
    old2 = old.replace('\n', '\r\n')
    new2 = new.replace('\n', '\r\n')
    if old2 in c:
        c = c.replace(old2, new2, 1)
        print("PATCHED OK (CRLF)")
    else:
        print("STILL NOT FOUND")
        idx = c.find('gtab-vendas-historico')
        print("Found tab div at:", idx)
        print(repr(c[idx:idx+300]))

with open('index.html', 'w', encoding='utf-8') as f:
    f.write(c)
