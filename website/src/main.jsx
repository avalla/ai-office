import React from 'react'
import ReactDOM from 'react-dom/client'
import './styles.css'

function App() {
  const officeExamples = [
    {
      id: 'software-studio',
      name: 'TypeScript Web App',
      emoji: '💻',
      description: 'Generated pipeline for frontend, backend, tests, review, and release',
      bestFor: 'SaaS and product teams',
      roles: 'product, architect, developer, qa, reviewer',
      features: [
        'Repo-specific PRD and plan',
        'Typecheck, lint, and test gates',
        'Focused role set',
        'Release evidence',
        'Token-efficient context'
      ]
    },
    {
      id: 'lean-startup',
      name: 'Supabase/Postgres App',
      emoji: '🚀',
      description: 'Generated flow for data model, RLS design, migrations, tests, and QA',
      bestFor: 'Apps with auth, data, and policies',
      roles: 'product, architect, developer, qa, database-security',
      features: [
        'RLS/security design',
        'Migration plan',
        'pgTAP-aware gates',
        'Policy review',
        'Rollback notes'
      ]
    },
    {
      id: 'game-studio',
      name: 'Frontend App',
      emoji: '🎮',
      description: 'Generated flow for UX notes, component plan, visual QA, and accessibility',
      bestFor: 'React, Vue, Svelte, Vite, and Next.js projects',
      roles: 'product, developer, qa, reviewer, ux',
      features: [
        'Component planning',
        'Visual QA',
        'Accessibility review',
        'Design-system notes',
        'User-flow checks'
      ]
    },
    {
      id: 'creative-agency',
      name: 'Infra-Heavy Project',
      emoji: '🎨',
      description: 'Generated flow for risk assessment, runbook, dry-run, validation, and rollback',
      bestFor: 'Docker, CI, Cloudflare, Vercel, Netlify, and ops-heavy repos',
      roles: 'architect, developer, qa, reviewer, ops',
      features: [
        'Risk assessment',
        'Runbook',
        'Dry-run gate',
        'Validation evidence',
        'Rollback plan'
      ]
    },
    {
      id: 'media-agency',
      name: 'Security-Sensitive App',
      emoji: '📹',
      description: 'Generated gates for auth, payments, secrets, permissions, and sensitive paths',
      bestFor: 'Auth, billing, PII, and permission-heavy products',
      roles: 'product, architect, developer, qa, security',
      features: [
        'Security review',
        'Secrets checks',
        'Permission boundaries',
        'Payment risk gates',
        'Audit trail'
      ]
    },
    {
      id: 'italian-legal-studio',
      name: 'Legacy Presets',
      emoji: '⚖️',
      description: 'Older agency templates remain available as examples and optional presets',
      bestFor: 'Teams that already rely on a preset workflow',
      roles: 'preset-defined',
      features: [
        'Optional preset selection',
        'Backward compatibility',
        'Example pipelines',
        'Preset roles',
        'Migration path'
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
      title: 'Generated Project Office',
      description: 'Repo-specific operating model stored in version control'
    },
    {
      icon: '👥',
      title: 'Minimal Roles',
      description: 'Only the roles needed for the detected project and risks'
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
      title: 'Legacy Presets',
      description: 'Existing presets remain available as examples'
    }
  ]

  const roles = [
    { name: 'Product', emoji: '📋', role: 'Scope and acceptance criteria' },
    { name: 'Architect', emoji: '🏗️', role: 'System design' },
    { name: 'Developer', emoji: '👨‍💻', role: 'Implementation' },
    { name: 'QA', emoji: '✅', role: 'Quality assurance' },
    { name: 'Reviewer', emoji: '👁️', role: 'Code review' },
    { name: 'Database Security', emoji: '🔒', role: 'RLS, migrations, data access' },
    { name: 'UX', emoji: '🎨', role: 'Visual QA and accessibility' },
    { name: 'Ops', emoji: '⚙️', role: 'CI, deploy, rollback' }
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
            <li><a href="#offices">Offices</a></li>
            <li><a href="#roles">Roles</a></li>
            <li><a href="#commands">Commands</a></li>
            <li><a href="#github" target="_blank" rel="noopener noreferrer">GitHub</a></li>
          </ul>
        </div>
      </nav>

      {/* Hero Section */}
      <section className="hero">
        <div className="container">
          <h1>🎯 AI Office</h1>
          <p>Repo-Native Workflow Layer for AI Coding Agents</p>
          <p style={{ fontSize: '1rem', opacity: 0.9 }}>
            Generate a custom project office from your repository: pipeline, roles, artifacts, and quality gates
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
            AI Office is a repo-native workflow and memory layer for AI coding tools.
            It inspects your project and generates a lightweight operating model while keeping everything in markdown and git.
          </p>
          <p>
            It is not an agent runtime. It gives your existing assistant durable project memory, state, tasks,
            quality gates, and role-specific instructions without a server, database, or SaaS dependency.
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

      {/* Offices */}
      <section id="offices">
        <div className="container">
          <h2>Generated Project Offices</h2>
          <p>Setup analyzes repo signals and generates the smallest useful pipeline, role set, artifacts, and quality gates.</p>

          <div className="agencies">
            {officeExamples.map(office => (
              <div
                key={office.id}
                className="agency-card"
              >
                <div className="agency-header">
                  <span style={{ fontSize: '2.5rem' }}>{office.emoji}</span>
                  <h3>{office.name}</h3>
                  <span className="agency-badge">{office.roles}</span>
                </div>
                <div className="agency-body">
                  <p><strong>{office.description}</strong></p>
                  <p style={{ fontSize: '0.9rem', color: '#6b7280' }}>Best for: {office.bestFor}</p>
                  <h4 style={{ marginTop: '1rem', marginBottom: '0.5rem', fontSize: '0.95rem', fontWeight: '600' }}>Features:</h4>
                  <ul className="agency-features">
                    {office.features.map(feature => (
                      <li key={feature}>{feature}</li>
                    ))}
                  </ul>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Roles */}
      <section id="roles" className="alternate">
        <div className="container">
          <h2>Minimal Generated Roles</h2>
          <p>Roles are short operational markdown files under <code>.ai-office/roles/</code>. AI Office never needs to load every role for a task.</p>

          <div className="agents-grid">
            {roles.map(role => (
              <div key={role.name} className="agent-card">
                <div className="agent-icon">{role.emoji}</div>
                <h4>{role.name}</h4>
                <p>{role.role}</p>
              </div>
            ))}
            <div className="agent-card" style={{ opacity: 0.6 }}>
              <div className="agent-icon">+</div>
              <h4>Only When Needed</h4>
              <p>Security, UX, ops, and database roles are added from repo signals.</p>
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
./setup.sh [project-path] --auto</code></pre>

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

      {/* Current Highlights */}
      <section className="alternate">
        <div className="container">
          <h2>Custom Office Outputs</h2>

          <div className="features">
            <div className="feature-card">
              <div className="feature-icon">✅</div>
              <h3>Office Profile</h3>
              <p>Detected project type, stack, risks, roles, and token rules</p>
            </div>
            <div className="feature-card">
              <div className="feature-icon">🚫</div>
              <h3>Pipeline</h3>
              <p>Repo-specific stage flow based on frontend, backend, data, infra, and security signals</p>
            </div>
            <div className="feature-card">
              <div className="feature-icon">📊</div>
              <h3>Roles</h3>
              <p>Minimal role profiles with purpose, inputs, outputs, token budget, and stop conditions</p>
            </div>
            <div className="feature-card">
              <div className="feature-icon">⚖️</div>
              <h3>Quality Gates</h3>
              <p>Project-specific verification gates and commands</p>
            </div>
            <div className="feature-card">
              <div className="feature-icon">📝</div>
              <h3>Markdown Artifacts</h3>
              <p>Profile, pipeline, gates, docs, tasks, and status files stay version-controlled</p>
            </div>
            <div className="feature-card">
              <div className="feature-icon">🔒</div>
              <h3>Token Budget</h3>
              <p>Context file caps, role limits, stage artifact limits, and review loop caps</p>
            </div>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="cta">
        <div className="container">
          <h2>Ready to Generate Your Project Office?</h2>
          <p>Start with your repository. AI Office generates the workflow around the code that is already there.</p>
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
              <a href="#offices">Offices</a>
              <a href="#roles">Roles</a>
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
