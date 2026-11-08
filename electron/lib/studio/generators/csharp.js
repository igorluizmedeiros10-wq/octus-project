'use strict';

/**
 * Gerador C# (WinForms, .NET 8) com interface escura real e persistência em disco.
 */

function csharpProject(bp) {
  return `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>WinExe</OutputType>
    <TargetFramework>net8.0-windows</TargetFramework>
    <UseWindowsForms>true</UseWindowsForms>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>disable</Nullable>
    <AssemblyName>${bp.name}</AssemblyName>
    <RootNamespace>${bp.name.replace(/[^A-Za-z0-9]/g, '') || 'App'}</RootNamespace>
    <ApplicationHighDpiMode>PerMonitorV2</ApplicationHighDpiMode>
  </PropertyGroup>
</Project>
`;
}

function csharpProgram(bp) {
  return `// ${bp.title} — gerado pelo Executive AI Studio (C# / WinForms)
using System;
using System.Windows.Forms;

namespace ${bp.name.replace(/[^A-Za-z0-9]/g, '') || 'App'};

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        ApplicationConfiguration.Initialize();
        Application.Run(new MainForm());
    }
}
`;
}

function csharpMainForm(bp) {
  const accent = bp.accent.replace('#', '');
  const r = parseInt(accent.slice(0, 2), 16);
  const g = parseInt(accent.slice(2, 4), 16);
  const b = parseInt(accent.slice(4, 6), 16);
  const isCalculator = bp.kind === 'calculator';
  const placeholder = isCalculator ? 'Expressao (ex.: (2+3)*4)' : bp.kind === 'tasks' ? 'Nova tarefa' : 'Nova nota';
  const addLabel = isCalculator ? 'Calcular' : 'Adicionar';

  return `// ${bp.title} — interface principal gerada pelo Executive AI Studio
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Windows.Forms;

namespace ${bp.name.replace(/[^A-Za-z0-9]/g, '') || 'App'};

public sealed class MainForm : Form
{
    private static readonly bool Calculator = ${isCalculator ? 'true' : 'false'};
    private static readonly Color BackgroundColor = Color.FromArgb(16, 17, 19);
    private static readonly Color PanelColor = Color.FromArgb(25, 27, 31);
    private static readonly Color AccentColor = Color.FromArgb(${r}, ${g}, ${b});
    private static readonly Color TextColor = Color.FromArgb(230, 234, 240);

    private readonly List<string> _items = new();
    private readonly string _dataFile;
    private readonly TextBox _input;
    private readonly ListBox _list;
    private readonly Label _status;

    public MainForm()
    {
        Text = "${bp.title.replace(/"/g, '\\"')}";
        Width = ${bp.window.width};
        Height = ${bp.window.height};
        MinimumSize = new Size(760, 520);
        BackColor = BackgroundColor;
        ForeColor = TextColor;
        Font = new Font("Segoe UI", 10f);
        StartPosition = FormStartPosition.CenterScreen;

        var directory = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
            "Executive AI Studio", "${bp.name}");
        Directory.CreateDirectory(directory);
        _dataFile = Path.Combine(directory, "data.txt");

        var title = new Label
        {
            Text = "${bp.title.replace(/"/g, '\\"')}",
            Font = new Font("Segoe UI", 18f, FontStyle.Bold),
            ForeColor = TextColor,
            AutoSize = true,
            Location = new Point(24, 20),
        };
        Controls.Add(title);

        var subtitle = new Label
        {
            Text = "${bp.kindLabel} • ${bp.languageLabel}",
            ForeColor = AccentColor,
            AutoSize = true,
            Location = new Point(26, 58),
        };
        Controls.Add(subtitle);

        _input = new TextBox
        {
            PlaceholderText = "${placeholder}",
            BackColor = PanelColor,
            ForeColor = TextColor,
            BorderStyle = BorderStyle.FixedSingle,
            Font = new Font("Segoe UI", 11f),
            Location = new Point(24, 92),
            Width = Width - 220,
            Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right,
        };
        _input.KeyDown += (_, args) =>
        {
            if (args.KeyCode == Keys.Enter)
            {
                args.SuppressKeyPress = true;
                Submit();
            }
        };
        Controls.Add(_input);

        var addButton = CreateButton("${addLabel}", 24);
        addButton.Click += (_, _) => Submit();

        var removeButton = CreateButton("Remover", 24 + 148);
        removeButton.Click += (_, _) => RemoveSelected();

        var clearButton = CreateButton("Limpar", 24 + 148 * 2);
        clearButton.Click += (_, _) => ClearAll();

        _list = new ListBox
        {
            BackColor = PanelColor,
            ForeColor = TextColor,
            BorderStyle = BorderStyle.FixedSingle,
            Font = new Font("Segoe UI", 11f),
            Location = new Point(24, 146),
            Size = new Size(Width - 64, Height - 240),
            Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right | AnchorStyles.Bottom,
            IntegralHeight = false,
        };
        Controls.Add(_list);

        _status = new Label
        {
            ForeColor = Color.FromArgb(150, 156, 166),
            AutoSize = true,
            Location = new Point(26, Height - 74),
            Anchor = AnchorStyles.Bottom | AnchorStyles.Left,
        };
        Controls.Add(_status);

        LoadItems();
        RefreshList();
    }

    private Button CreateButton(string text, int left)
    {
        var button = new Button
        {
            Text = text,
            BackColor = PanelColor,
            ForeColor = TextColor,
            FlatStyle = FlatStyle.Flat,
            Font = new Font("Segoe UI", 10f, FontStyle.Bold),
            Location = new Point(left, 92),
            Size = new Size(136, 36),
            Anchor = AnchorStyles.Top | AnchorStyles.Right,
        };
        button.FlatAppearance.BorderColor = AccentColor;
        button.FlatAppearance.MouseOverBackColor = Color.FromArgb(35, 60, 90);
        Controls.Add(button);
        return button;
    }

    private void LoadItems()
    {
        _items.Clear();
        if (!File.Exists(_dataFile)) return;
        foreach (var line in File.ReadAllLines(_dataFile))
        {
            if (!string.IsNullOrWhiteSpace(line)) _items.Add(line);
        }
    }

    private void SaveItems() => File.WriteAllLines(_dataFile, _items);

    private void RefreshList()
    {
        _list.BeginUpdate();
        _list.Items.Clear();
        foreach (var item in _items) _list.Items.Add(item);
        _list.EndUpdate();
        _status.Text = _items.Count + (_items.Count == 1 ? " item" : " itens");
    }

    private void Submit()
    {
        var entry = _input.Text.Trim();
        if (entry.Length == 0) return;

        if (Calculator)
        {
            try
            {
                var value = new ExpressionParser(entry).Parse();
                _items.Add(entry + " = " + value.ToString("0.############", CultureInfo.InvariantCulture));
            }
            catch (FormatException)
            {
                MessageBox.Show(this, "Expressao invalida. Use numeros, +, -, *, / e parenteses.",
                    "Calculadora", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
        }
        else
        {
            _items.Add(entry);
        }

        _input.Clear();
        SaveItems();
        RefreshList();
        _list.TopIndex = Math.Max(0, _list.Items.Count - 1);
    }

    private void RemoveSelected()
    {
        var index = _list.SelectedIndex;
        if (index < 0 || index >= _items.Count) return;
        _items.RemoveAt(index);
        SaveItems();
        RefreshList();
    }

    private void ClearAll()
    {
        if (_items.Count == 0) return;
        if (MessageBox.Show(this, "Remover todos os itens?", "Confirmar",
                MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes) return;
        _items.Clear();
        SaveItems();
        RefreshList();
    }
}

/// <summary>Avaliador aritmetico seguro, sem uso de eval/reflexao.</summary>
public sealed class ExpressionParser
{
    private readonly string _text;
    private int _position;

    public ExpressionParser(string text) => _text = text ?? string.Empty;

    public double Parse()
    {
        var value = ParseExpression();
        SkipSpaces();
        if (_position != _text.Length) throw new FormatException("Expressao invalida.");
        return value;
    }

    private void SkipSpaces()
    {
        while (_position < _text.Length && char.IsWhiteSpace(_text[_position])) _position++;
    }

    private double ParseExpression()
    {
        var value = ParseTerm();
        while (true)
        {
            SkipSpaces();
            if (_position >= _text.Length) return value;
            var op = _text[_position];
            if (op != '+' && op != '-') return value;
            _position++;
            var right = ParseTerm();
            value = op == '+' ? value + right : value - right;
        }
    }

    private double ParseTerm()
    {
        var value = ParseFactor();
        while (true)
        {
            SkipSpaces();
            if (_position >= _text.Length) return value;
            var op = _text[_position];
            if (op != '*' && op != '/') return value;
            _position++;
            var right = ParseFactor();
            if (op == '/' && right == 0) throw new FormatException("Divisao por zero.");
            value = op == '*' ? value * right : value / right;
        }
    }

    private double ParseFactor()
    {
        SkipSpaces();
        if (_position < _text.Length && _text[_position] == '-')
        {
            _position++;
            return -ParseFactor();
        }
        if (_position < _text.Length && _text[_position] == '(')
        {
            _position++;
            var inner = ParseExpression();
            SkipSpaces();
            if (_position >= _text.Length || _text[_position] != ')') throw new FormatException("Parenteses invalidos.");
            _position++;
            return inner;
        }
        var start = _position;
        while (_position < _text.Length && (char.IsDigit(_text[_position]) || _text[_position] == '.' ||
               _text[_position] == ',')) _position++;
        if (start == _position) throw new FormatException("Numero esperado.");
        var raw = _text.Substring(start, _position - start).Replace(',', '.');
        if (!double.TryParse(raw, NumberStyles.Float, CultureInfo.InvariantCulture, out var value))
            throw new FormatException("Numero invalido.");
        return value;
    }
}
`;
}

module.exports = { csharpProject, csharpProgram, csharpMainForm };
