import re

with open('index.html', 'r', encoding='utf-8') as f:
    content = f.read()

# Find the specific closing section tag for the pessoal kpi-grid
# We identify it by the unique element just before it
needle = '                    <span class="kpi-subtext">A vencer / Em aberto</span>\n                </div>\n            </div>\n        </section>'

new_kpi_section = '''                    <span class="kpi-subtext">A vencer / Em aberto</span>
                </div>
            </div>
        </section>

        <section class="kpi-grid" style="margin-top:0; padding-top:0;">
            <div class="kpi-card" style="border: 2px solid var(--brand-500); background: linear-gradient(135deg, rgba(99,102,241,0.13) 0%, rgba(30,41,59,1) 100%);">
                <div class="kpi-icon" style="background: var(--brand-600);"><i class="fa-solid fa-sack-dollar"></i></div>
                <div class="kpi-content">
                    <span class="kpi-label" style="color: var(--brand-400);">Saldo Disponível da Gráfica</span>
                    <h2 id="kpiSaldoDisponivelGrafica" style="color: var(--brand-400);">R$ 0,00</h2>
                    <span class="kpi-subtext">Lucro Líquido (Vendas - Custos - Desp. Loja)</span>
                </div>
            </div>
            <div class="kpi-card" style="border: 2px solid #10b981; background: linear-gradient(135deg, rgba(16,185,129,0.12) 0%, rgba(30,41,59,1) 100%);">
                <div class="kpi-icon" style="background: #065f46;"><i class="fa-solid fa-wallet"></i></div>
                <div class="kpi-content">
                    <span class="kpi-label" style="color: #34d399;">Sobra Livre (Lucro Final)</span>
                    <h2 id="kpiSaldoFinalLivre" style="color: #34d399;">R$ 0,00</h2>
                    <span class="kpi-subtext">Saldo da gráfica menos todas as despesas de casa</span>
                </div>
            </div>
        </section>'''

if needle in content:
    content = content.replace(needle, new_kpi_section, 1)
    print("PATCHED OK")
else:
    # Try with \r\n
    needle2 = needle.replace('\n', '\r\n')
    new_kpi2 = new_kpi_section.replace('\n', '\r\n')
    if needle2 in content:
        content = content.replace(needle2, new_kpi2, 1)
        print("PATCHED OK (CRLF)")
    else:
        print("NEEDLE NOT FOUND - dumping context...")
        idx = content.find('A vencer / Em aberto')
        print(repr(content[idx:idx+200]))

with open('index.html', 'w', encoding='utf-8') as f:
    f.write(content)
