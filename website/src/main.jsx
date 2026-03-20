import React from 'react'
import ReactDOM from 'react-dom/client'
import './styles.css'

function App() {
  const agencies = [
    {
      id: 'software-studio',
      name: 'Software Studio',
      emoji: '💻',
      description: 'Full-stack SaaS development with 13 specialized agents',
      bestFor: 'Enterprise software teams',
      agents: 13,
      features: [
        'Complete dev lifecycle',
        'QA & testing',
        'Code review pipeline',
        'Release management',
        'Security & compliance'
      ]
    },
    {
      id: 'lean-startup',
      name: 'Lean Startup',
      emoji: '🚀',
      description: 'Rapid MVP development with 7 core agents',
      bestFor: 'Startups & MVPs',
      agents: 7,
      features: [
        'Fast iteration',
        'Minimal overhead',
        'Quick deployment',
        'Growth-focused',
        'Flexible pipeline'
      ]
    },
    {
      id: 'game-studio',
      name: 'Game Studio',
      emoji: '🎮',
      description: 'Game development with custom pipeline and tools',
      bestFor: 'Game developers',
      agents: 10,
      features: [
        'Asset management',
        'Game mechanics testing',
        'Performance optimization',
        'Build distribution',
        'Player feedback loop'
      ]
    },
    {
      id: 'creative-agency',
      name: 'Creative Agency',
      emoji: '🎨',
      description: 'Media production with focus on creators',
      bestFor: 'Creative teams',
      agents: 8,
      features: [
        'Design & UX',
        'Content creation',
        'Audio/Video production',
        'Brand management',
        'Feedback loops'
      ]
    },
    {
      id: 'media-agency',
      name: 'Media Agency',
      emoji: '📹',
      description: 'Video and film production pipeline',
      bestFor: 'Media production',
      agents: 9,
      features: [
        'Production planning',
        'Scheduling',
        'Video editing',
        'Distribution',
        'Analytics'
      ]
    },
    {
      id: 'italian-legal-studio',
      name: 'Italian Legal Studio',
      emoji: '⚖️',
      description: 'Italian law firm workflows with compliance',
      bestFor: 'Italian legal practices',
      agents: 6,
      features: [
        'Case management',
        'Italian law compliance',
        'Document templates',
        'Deadline tracking',
        'Partner workflows'
      ]
    },
    {
      id: 'furniture-cad-studio',
      name: 'Furniture CAD Studio',
      emoji: '🪑',
      description: 'Furniture design and CAD modeling with FreeCAD',
      bestFor: 'Furniture designers & makers',
      agents: 10,
      features: [
        'FreeCAD parametric modeling',
        'STEP/STL export',
        'Structural review',
        'Materials specification',
        'Manufacturing documentation'
      ]
    },
    {
      id: 'penetration-test-agency',
      name: 'Penetration Test Agency',
      emoji: '🔐',
      description: 'Offensive security testing, vulnerability validation, and remediation assurance',
      bestFor: 'Security teams & pentesters',
      agents: 11,
      features: [
        'Web, API & infrastructure testing',
        'Evidence-driven findings',
        'Remediation validation',
        'Risk scoring & reporting',
        'CVE & OWASP coverage'
      ]
    },
    {
      id: 'crypto-scalping-studio',
      name: 'Crypto Scalping Studio',
      emoji: '📈',
      description: 'Scalping strategy development, signal generation, and live trading operations',
      bestFor: 'Crypto traders & signal services',
      agents: 9,
      features: [
        'Signal design & backtesting',
        'Scalping execution rules',
        'Risk & drawdown management',
        'Paper trade validation',
        'Live deployment & monitoring'
      ]
    }
  ]

  const commands = [
    {
      category: 'Core Routing',
      commands: [
        '/office:route — Classify request, run discussion, suggest pipeline',
        '/office:advance — Move to next stage, reassign tasks',
        '/office:status — Get/update pipeline status'
      ]
    },
    {
      category: 'Task Management',
      commands: [
        '/office:task-create — New task (with optional slug field)',
        '/office:task-move — Move between columns (BLOCKED support)',
        '/office:task-list — View kanban (Labels column)'
      ]
    },
    {
      category: 'Quality & Testing',
      commands: [
        '/office:verify — QA verification',
        '/office:validate — Check quality gates',
        '/office:review — Multi-sector code review'
      ]
    },
    {
      category: 'Reporting',
      commands: [
        '/office:report status|investor|tech-debt|audit|velocity',
        '/office:milestone — Create/manage milestones',
        '/office:run-tests — Execute tests, track coverage'
      ]
    }
  ]

  const features = [
    {
      icon: '📋',
      title: 'File-based Agency',
      description: 'Complete virtual agency system stored in version control'
    },
    {
      icon: '👥',
      title: '27 Agents',
      description: 'Specialized agents with personalities, skills, and workflows'
    },
    {
      icon: '📊',
      title: 'Kanban Board',
      description: '7 columns for task tracking with full visibility'
    },
    {
      icon: '🛡️',
      title: 'Loop Guards',
      description: 'Prevent infinite cycles with hard iteration limits'
    },
    {
      icon: '📝',
      title: 'Artifacts',
      description: 'PRD, ADR, and runbooks for complete documentation'
    },
    {
      icon: '⚖️',
      title: 'Legal Studio',
      description: 'Italian law compliance built into framework'
    }
  ]

  const agents = [
    { name: 'Router', emoji: '🧭', role: 'Request classification' },
    { name: 'CEO', emoji: '👔', role: 'Strategic decisions' },
    { name: 'PM', emoji: '📋', role: 'Product management' },
    { name: 'Architect', emoji: '🏗️', role: 'System design' },
    { name: 'Developer', emoji: '👨‍💻', role: 'Implementation' },
    { name: 'Designer', emoji: '🎨', role: 'UI/UX design' },
    { name: 'QA', emoji: '✅', role: 'Quality assurance' },
    { name: 'Reviewer', emoji: '👁️', role: 'Code review' },
    { name: 'Security', emoji: '🔒', role: 'Security audit' },
    { name: 'Ops', emoji: '⚙️', role: 'Operations' },
    { name: 'Release Manager', emoji: '🚀', role: 'Deployments' },
    { name: 'Audio Creator', emoji: '🎵', role: 'Audio production' }
  ]

  return (
    <div className="app">
      {/* Navigation */}
      <nav>
        <div className="container">
          <div className="nav-brand">
            <span>🎯</span> AI Office
          </div>
          <ul className="nav-links">
            <li><a href="#features">Features</a></li>
            <li><a href="#agencies">Agencies</a></li>
            <li><a href="#agents">Agents</a></li>
            <li><a href="#commands">Commands</a></li>
            <li><a href="#github" target="_blank" rel="noopener noreferrer">GitHub</a></li>
          </ul>
        </div>
      </nav>

      {/* Hero Section */}
      <section className="hero">
        <div className="container">
          <h1>🎯 AI Office</h1>
          <p>Multi-Agent Software Development Framework</p>
          <p style={{ fontSize: '1rem', opacity: 0.9 }}>
            Coordinate 27 specialized AI agents through complete software development pipelines
          </p>
          <div className="hero-buttons">
            <button className="btn btn-primary" onClick={() => {
              document.querySelector('#getting-started').scrollIntoView({ behavior: 'smooth' })
            }}>
              Get Started
            </button>
            <a href="https://github.com/avalla/ai-office-claude-code" target="_blank" rel="noopener noreferrer">
              <button className="btn btn-secondary">View on GitHub</button>
            </a>
          </div>
        </div>
      </section>

      {/* What is AI Office */}
      <section id="about">
        <div className="container">
          <h2>What is AI Office?</h2>
          <p>
            AI Office is a complete framework for coordinating multiple AI agents through your software development lifecycle.
            It provides structure, governance, and automation while maintaining full version control and auditability.
          </p>
          <p>
            Think of it as a virtual agency: a file-based system where agents have personalities, competencies, triggers,
            and workflows. It works for software teams, law firms, creative agencies, and more.
          </p>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="alternate">
        <div className="container">
          <h2>Key Features</h2>
          <div className="features">
            {features.map(feature => (
              <div key={feature.title} className="feature-card">
                <div className="feature-icon">{feature.icon}</div>
                <h3>{feature.title}</h3>
                <p>{feature.description}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Agencies */}
      <section id="agencies">
        <div className="container">
          <h2>9 Pre-Built Agencies</h2>
          <p>Each agency has a custom pipeline, roles, and templates optimized for its domain.</p>

          <div className="agencies">
            {agencies.map(agency => (
              <div
                key={agency.id}
                className="agency-card"
              >
                <div className="agency-header">
                  <span style={{ fontSize: '2.5rem' }}>{agency.emoji}</span>
                  <h3>{agency.name}</h3>
                  <span className="agency-badge">{agency.agents} agents</span>
                </div>
                <div className="agency-body">
                  <p><strong>{agency.description}</strong></p>
                  <p style={{ fontSize: '0.9rem', color: '#6b7280' }}>Best for: {agency.bestFor}</p>
                  <h4 style={{ marginTop: '1rem', marginBottom: '0.5rem', fontSize: '0.95rem', fontWeight: '600' }}>Features:</h4>
                  <ul className="agency-features">
                    {agency.features.map(feature => (
                      <li key={feature}>{feature}</li>
                    ))}
                  </ul>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Agents */}
      <section id="agents" className="alternate">
        <div className="container">
          <h2>27 Specialized Agents</h2>
          <p>Each agent has personality, competencies, triggers, workflows, and skills. Mix and match for custom agencies.</p>

          <div className="agents-grid">
            {agents.map(agent => (
              <div key={agent.name} className="agent-card">
                <div className="agent-icon">{agent.emoji}</div>
                <h4>{agent.name}</h4>
                <p>{agent.role}</p>
              </div>
            ))}
            <div className="agent-card" style={{ opacity: 0.6 }}>
              <div className="agent-icon">+</div>
              <h4>15 More</h4>
              <p>Plus many more specialized agents...</p>
            </div>
          </div>
        </div>
      </section>

      {/* Commands */}
      <section id="commands">
        <div className="container">
          <h2>23 Powerful Commands</h2>
          <p>Slash commands orchestrate the entire framework and are self-documenting.</p>

          <div className="commands-grid">
            {commands.map(group => (
              <div key={group.category} className="command-group">
                <h4>{group.category}</h4>
                <ul className="command-list">
                  {group.commands.map(cmd => (
                    <li key={cmd}>
                      <code>{cmd}</code>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Quick Start */}
      <section id="getting-started" className="alternate">
        <div className="container">
          <h2>Quick Start</h2>

          <h3 style={{ marginTop: '2rem' }}>1️⃣ Install</h3>
          <pre><code>./install.sh [project-path]
./setup.sh [project-path]</code></pre>

          <h3 style={{ marginTop: '2rem' }}>2️⃣ Start a Feature</h3>
          <pre><code>/office:route Add real-time notifications</code></pre>

          <h3 style={{ marginTop: '2rem' }}>3️⃣ Create Milestone</h3>
          <pre><code>/office:milestone create M1 "Notifications" tasks:yes</code></pre>

          <h3 style={{ marginTop: '2rem' }}>4️⃣ Execute Pipeline</h3>
          <pre><code>/office:scaffold notifications prd
/office:advance notifications prd "PRD approved"
# ... continue through pipeline ...</code></pre>

          <p style={{ marginTop: '2rem', fontStyle: 'italic', color: '#6b7280' }}>
            📚 Full documentation available on <a href="https://github.com/avalla/ai-office-claude-code" target="_blank" rel="noopener noreferrer">GitHub</a>
          </p>
        </div>
      </section>

      {/* v1.4.0 Highlights */}
      <section className="alternate">
        <div className="container">
          <h2>What's New in v1.4.0</h2>

          <div className="features">
            <div className="feature-card">
              <div className="feature-icon">✅</div>
              <h3>Task Slug Field</h3>
              <p>Link tasks to parent features for better tracking and organization</p>
            </div>
            <div className="feature-card">
              <div className="feature-icon">🚫</div>
              <h3>BLOCKED Column</h3>
              <p>Tasks with blockers are tracked with explicit unblock criteria</p>
            </div>
            <div className="feature-card">
              <div className="feature-icon">📊</div>
              <h3>Velocity Reporting</h3>
              <p>Track team throughput and metrics per milestone</p>
            </div>
            <div className="feature-card">
              <div className="feature-icon">⚖️</div>
              <h3>Italian Legal Studio</h3>
              <p>Complete agency for Italian law firms with compliance built-in</p>
            </div>
            <div className="feature-card">
              <div className="feature-icon">📝</div>
              <h3>New Artifacts</h3>
              <p>Discuss & Runbook artifacts for better documentation</p>
            </div>
            <div className="feature-card">
              <div className="feature-icon">🔒</div>
              <h3>Loop Guards</h3>
              <p>All status files include guards table to prevent infinite cycles</p>
            </div>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="cta">
        <div className="container">
          <h2>Ready to Coordinate Your AI Agents?</h2>
          <p>Start with the framework and customize for your team's workflow.</p>
          <div className="hero-buttons" style={{ marginTop: '2rem' }}>
            <a href="https://github.com/avalla/ai-office-claude-code" target="_blank" rel="noopener noreferrer">
              <button className="btn btn-primary">View on GitHub</button>
            </a>
            <a href="https://github.com/avalla/ai-office-claude-code#readme" target="_blank" rel="noopener noreferrer">
              <button className="btn btn-secondary">Read Docs</button>
            </a>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer>
        <div className="container">
          <div className="footer-content">
            <div className="footer-section">
              <h4>AI Office</h4>
              <a href="#about">About</a>
              <a href="#features">Features</a>
              <a href="#agencies">Agencies</a>
              <a href="#agents">Agents</a>
            </div>
            <div className="footer-section">
              <h4>Resources</h4>
              <a href="https://github.com/avalla/ai-office-claude-code" target="_blank" rel="noopener noreferrer">GitHub Repository</a>
              <a href="https://github.com/avalla/ai-office-claude-code#readme" target="_blank" rel="noopener noreferrer">Documentation</a>
              <a href="https://github.com/avalla/ai-office-claude-code/issues" target="_blank" rel="noopener noreferrer">Issues</a>
            </div>
            <div className="footer-section">
              <h4>Community</h4>
              <a href="https://github.com/avalla/ai-office-claude-code/discussions" target="_blank" rel="noopener noreferrer">Discussions</a>
              <a href="https://github.com/avalla/ai-office-claude-code/blob/main/CONTRIBUTING.md" target="_blank" rel="noopener noreferrer">Contributing</a>
            </div>
            <div className="footer-section">
              <h4>Legal</h4>
              <a href="https://github.com/avalla/ai-office-claude-code/blob/main/LICENSE" target="_blank" rel="noopener noreferrer">License (MIT)</a>
              <a href="https://github.com/avalla" target="_blank" rel="noopener noreferrer">Anthropic</a>
            </div>
          </div>
          <div className="footer-bottom">
            <p>© 2026 Andrea Valla. AI Office is open source under the MIT License.</p>
            <p style={{ marginTop: '0.5rem' }}>Built with ❤️ for AI development teams everywhere</p>
          </div>
        </div>
      </footer>
    </div>
  )
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
