c = open('index.html', 'r', encoding='utf-8').read()

start = c.find('    <!-- TAB 2:')
end_marker = '    <!-- TAB 3:'
end = c.find(end_marker)
old_block = c[start:end]

new_block = '''    <!-- TAB 2: Histórico de Vendas e Pedidos (Aba Separada) -->
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
    </div>

'''

c = c[:start] + new_block + c[end:]
open('index.html', 'w', encoding='utf-8').write(c)
print("DONE - replaced block of", len(old_block), "chars with", len(new_block), "chars")
