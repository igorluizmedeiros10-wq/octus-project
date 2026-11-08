'use strict';

/**
 * Gerador Python (Tkinter) com interface escura, persistência JSON e avaliador seguro via ast.
 */

function pythonApp(bp) {
  const isCalculator = bp.kind === 'calculator';
  const placeholder = isCalculator ? 'Expressao (ex.: (2+3)*4)' : bp.kind === 'tasks' ? 'Nova tarefa' : 'Nova nota';
  const addLabel = isCalculator ? 'Calcular' : 'Adicionar';

  return `"""${bp.title} — gerado pelo Executive AI Studio (Python / Tkinter).

Modelo: ${bp.kindLabel}
Execute com: python app.py
Gere o executavel com: build.ps1 (Windows) ou ./build.sh
"""

from __future__ import annotations

import ast
import json
import os
import tkinter as tk
from tkinter import messagebox

APP_TITLE = "${bp.title.replace(/"/g, '\\"')}"
APP_SLUG = "${bp.name}"
CALCULATOR = ${isCalculator ? 'True' : 'False'}
ACCENT = "${bp.accent}"
BACKGROUND = "#101113"
PANEL = "#191b1f"
TEXT = "#e6eaf0"
MUTED = "#969ca6"


def data_file() -> str:
    base = os.getenv("APPDATA") or os.path.join(os.path.expanduser("~"), ".local", "share")
    directory = os.path.join(base, "Executive AI Studio", APP_SLUG)
    os.makedirs(directory, exist_ok=True)
    return os.path.join(directory, "data.json")


class SafeEvaluator(ast.NodeVisitor):
    """Avalia expressoes aritmeticas sem usar eval()."""

    def visit_Expression(self, node: ast.Expression) -> float:
        return self.visit(node.body)

    def visit_BinOp(self, node: ast.BinOp) -> float:
        left = self.visit(node.left)
        right = self.visit(node.right)
        if isinstance(node.op, ast.Add):
            return left + right
        if isinstance(node.op, ast.Sub):
            return left - right
        if isinstance(node.op, ast.Mult):
            return left * right
        if isinstance(node.op, ast.Div):
            if right == 0:
                raise ValueError("Divisao por zero.")
            return left / right
        if isinstance(node.op, ast.Mod):
            if right == 0:
                raise ValueError("Divisao por zero.")
            return left % right
        if isinstance(node.op, ast.Pow):
            return left ** right
        raise ValueError("Operador nao suportado.")

    def visit_UnaryOp(self, node: ast.UnaryOp) -> float:
        value = self.visit(node.operand)
        if isinstance(node.op, ast.USub):
            return -value
        return value

    def visit_Constant(self, node: ast.Constant) -> float:
        if isinstance(node.value, (int, float)):
            return float(node.value)
        raise ValueError("Valor invalido.")

    def generic_visit(self, node):  # pragma: no cover - bloqueia o resto
        raise ValueError("Expressao nao permitida.")


def evaluate(expression: str) -> float:
    tree = ast.parse(expression, mode="eval")
    return SafeEvaluator().visit(tree)


class StudioApp(tk.Tk):
    def __init__(self) -> None:
        super().__init__()
        self.title(APP_TITLE)
        self.geometry("${bp.window.width}x${bp.window.height}")
        self.minsize(760, 520)
        self.configure(bg=BACKGROUND)
        self.items: list[str] = []
        self.path = data_file()

        header = tk.Frame(self, bg=BACKGROUND)
        header.pack(fill="x", padx=24, pady=(20, 0))
        tk.Label(header, text=APP_TITLE, bg=BACKGROUND, fg=TEXT, font=("Segoe UI", 20, "bold")).pack(anchor="w")
        tk.Label(header, text="${bp.kindLabel} • ${bp.languageLabel}", bg=BACKGROUND, fg=ACCENT,
                 font=("Segoe UI", 10)).pack(anchor="w", pady=(2, 0))

        controls = tk.Frame(self, bg=BACKGROUND)
        controls.pack(fill="x", padx=24, pady=(16, 8))

        self.entry = tk.Entry(controls, bg=PANEL, fg=TEXT, insertbackground=TEXT, relief="flat",
                              font=("Segoe UI", 12), highlightthickness=1,
                              highlightbackground="#2a2d33", highlightcolor=ACCENT)
        self.entry.insert(0, "")
        self.entry.pack(side="left", fill="x", expand=True, ipady=8)
        self.entry.bind("<Return>", lambda _event: self.submit())
        self.entry.focus_set()

        tk.Button(controls, text="${addLabel}", command=self.submit, bg=PANEL, fg=TEXT, relief="flat",
                  activebackground=ACCENT, activeforeground="#04121f", font=("Segoe UI", 10, "bold"),
                  padx=18, pady=6).pack(side="left", padx=(12, 0))
        tk.Button(controls, text="Remover", command=self.remove_selected, bg=PANEL, fg=TEXT, relief="flat",
                  activebackground="#2a2d33", font=("Segoe UI", 10), padx=14, pady=6).pack(side="left", padx=(8, 0))
        tk.Button(controls, text="Limpar", command=self.clear_all, bg=PANEL, fg=TEXT, relief="flat",
                  activebackground="#2a2d33", font=("Segoe UI", 10), padx=14, pady=6).pack(side="left", padx=(8, 0))

        list_frame = tk.Frame(self, bg=BACKGROUND)
        list_frame.pack(fill="both", expand=True, padx=24, pady=(8, 0))

        scrollbar = tk.Scrollbar(list_frame, orient="vertical")
        self.listbox = tk.Listbox(list_frame, bg=PANEL, fg=TEXT, selectbackground=ACCENT,
                                  selectforeground="#04121f", relief="flat", font=("Segoe UI", 11),
                                  highlightthickness=1, highlightbackground="#2a2d33",
                                  yscrollcommand=scrollbar.set, activestyle="none")
        scrollbar.config(command=self.listbox.yview)
        scrollbar.pack(side="right", fill="y")
        self.listbox.pack(side="left", fill="both", expand=True)

        self.status = tk.Label(self, text="", bg=BACKGROUND, fg=MUTED, font=("Segoe UI", 9))
        self.status.pack(anchor="w", padx=26, pady=(6, 14))

        self.load_items()
        self.refresh()

    def load_items(self) -> None:
        try:
            with open(self.path, "r", encoding="utf-8") as handle:
                data = json.load(handle)
            if isinstance(data, list):
                self.items = [str(item) for item in data]
        except (OSError, ValueError):
            self.items = []

    def save_items(self) -> None:
        try:
            with open(self.path, "w", encoding="utf-8") as handle:
                json.dump(self.items, handle, ensure_ascii=False, indent=2)
        except OSError as error:
            messagebox.showerror("Falha ao salvar", str(error))

    def refresh(self) -> None:
        self.listbox.delete(0, tk.END)
        for item in self.items:
            self.listbox.insert(tk.END, item)
        self.status.config(text=f"{len(self.items)} " + ("item" if len(self.items) == 1 else "itens"))

    def submit(self) -> None:
        entry = self.entry.get().strip()
        if not entry:
            return
        if CALCULATOR:
            try:
                result = evaluate(entry)
            except (ValueError, SyntaxError) as error:
                messagebox.showwarning("Calculadora", f"Expressao invalida: {error}")
                return
            self.items.append(f"{entry} = {result:g}")
        else:
            self.items.append(entry)
        self.entry.delete(0, tk.END)
        self.save_items()
        self.refresh()
        self.listbox.see(tk.END)

    def remove_selected(self) -> None:
        selection = self.listbox.curselection()
        if not selection:
            return
        del self.items[selection[0]]
        self.save_items()
        self.refresh()

    def clear_all(self) -> None:
        if not self.items:
            return
        if not messagebox.askyesno("Confirmar", "Remover todos os itens?"):
            return
        self.items.clear()
        self.save_items()
        self.refresh()


if __name__ == "__main__":
    StudioApp().mainloop()
`;
}

module.exports = { pythonApp };
