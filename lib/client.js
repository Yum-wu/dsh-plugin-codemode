// 自动思考深度状态感知 (Auto Reasoning Effort) 客户端实时胶囊
// 注入到 DSH Web 界面的 conversation.composer.dock 插槽中（紧贴输入框底栏，与影子盘状态条同级）
window.__ModuleLoader__.load({
  id: "dsh-plugin-codemode",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    const React = require("react");

    const T = {
      line: 'var(--dsw-alias-border-l1)',
      ink: 'var(--dsw-alias-label-primary)',
      ink2: 'var(--dsw-alias-label-secondary)',
      green: 'var(--dsw-alias-state-success-primary)',
      amber: 'var(--dsw-alias-state-warn-primary)',
      red: 'var(--dsw-alias-state-error-primary)',
      purple: '#a855f7',
      blue: '#3b82f6',
    };

    const AutoEffortPill = () => {
      const [currentLevel, setCurrentLevel] = React.useState('auto (待首次请求)');
      const [score, setScore] = React.useState(null);
      const [detail, setDetail] = React.useState('');

      React.useEffect(() => {
        // 档位由服务端 agent/request 决策，这里只读它暴露的只读路由。
        // 旧实现是爬 document.body.innerText 找 "[Auto (x)]" 文本标记，宿主从没产出过那个标记，
        // 所以胶囊永远停在 "detecting"。
        let cancelled = false;
        const poll = async () => {
          try {
            const res = await fetch('/api/codemode.auto-effort', { credentials: 'same-origin', cache: 'no-store' });
            if (!res.ok) return;
            const data = await res.json();
            if (cancelled || !data || data.idle) return;
            setCurrentLevel(`Auto (${data.effort})`);
            setScore(data.score);
            setDetail(`${data.model} · ${data.reason} · 阶梯 ${Array.isArray(data.ladder) ? data.ladder.join('/') : '-'}`);
          } catch {}
        };
        poll();
        const timer = setInterval(poll, 3000);
        return () => { cancelled = true; clearInterval(timer); };
      }, []);

      const getColor = (lvl) => {
        const l = lvl.toLowerCase();
        if (l.includes('max') || l.includes('xhigh')) return T.purple;
        if (l.includes('high')) return T.red;
        if (l.includes('medium')) return T.amber;
        if (l.includes('low') || l.includes('minimal')) return T.green;
        return T.blue;
      };

      const color = getColor(currentLevel);

      return React.createElement(
        'div',
        {
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '2px 8px',
            borderRadius: 999,
            border: `1px solid ${color}44`,
            background: `color-mix(in srgb, ${color} 10%, transparent)`,
            cursor: 'default',
            marginRight: 8,
          },
          title: score ? `复杂度评分 ${score}/10${detail ? ' · ' + detail : ''}` : '自适应思考深度已激活',
        },
        [
          React.createElement('span', {
            style: {
              width: 6,
              height: 6,
              borderRadius: 999,
              background: color,
              boxShadow: `0 0 6px ${color}`,
            },
          }),
          React.createElement(
            'span',
            {
              style: {
                fontSize: 11,
                fontWeight: 700,
                color: color,
                fontFamily: 'monospace',
                letterSpacing: '0.02em',
              },
            },
            currentLevel + (score ? ` · ${score}/10` : '')
          ),
        ]
      );
    };

    const inject = ["slots"];
    function apply(ctx) {
      const slots = ctx.get("slots");
      if (!slots) return;

      slots.inject('conversation.composer.dock', () =>
        slots.register(
          { name: 'conversation.composer.dock', id: 'auto-reasoning-pill', order: 5 },
          () => React.createElement(AutoEffortPill, null)
        )
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
