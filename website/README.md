# AI Office Website

Professional marketing and documentation website for the AI Office framework.

## Features

- **Responsive Design** — Works on desktop, tablet, and mobile
- **Interactive Agency Selector** — Click to compare 6 pre-built agencies
- **Complete Feature Overview** — All capabilities at a glance
- **Quick Start Guide** — Installation and usage examples
- **Modern UI** — Built with React and Vite for performance

## Development

### Prerequisites

- Node.js 16+
- npm or yarn

### Install Dependencies

```bash
npm install
```

### Run Development Server

```bash
npm run dev
```

The site will open automatically at `http://localhost:3000` with hot reload enabled.

### Build for Production

```bash
npm run build
```

Output will be in the `dist/` directory. The built site is static HTML/CSS/JS and can be deployed anywhere.

### Preview Production Build

```bash
npm run preview
```

## Deployment

The built website can be deployed to:

- **Vercel** — `npm install -g vercel && vercel`
- **Netlify** — Connect GitHub repo directly
- **GitHub Pages** — Configure in repository settings
- **Any static hosting** — Upload contents of `dist/` folder

### GitHub Pages Deployment

1. Update `vite.config.js` to set `base: '/ai-office/'` (if deploying to a subdirectory)
2. Run `npm run build`
3. Push `dist/` folder to `gh-pages` branch or enable in repo settings

## Structure

```
website/
├── index.html          # Entry point
├── vite.config.js      # Vite configuration
├── package.json        # Dependencies
└── src/
    ├── main.jsx        # React app (all components)
    └── styles.css      # Global styles
```

## Customization

### Colors

Edit CSS variables in `src/styles.css`:

```css
:root {
  --primary: #2563eb;
  --secondary: #10b981;
  --accent: #f59e0b;
  /* ... more colors ... */
}
```

### Content

Edit `src/main.jsx` to update:

- Navigation links
- Feature descriptions
- Agency information
- Agent roster
- Commands list
- Quick start steps

### Styling

All styles are in `src/styles.css`. Key sections:

- Navigation and header
- Hero section
- Feature cards
- Agency cards
- Commands grid
- Footer

## Performance

- **Vite** provides fast development and optimized production builds
- **React** keeps the UI interactive and responsive
- **CSS Grid/Flexbox** for responsive layouts
- **Minimal dependencies** — only React and Vite

## Browser Support

- Chrome 90+
- Firefox 88+
- Safari 14+
- Edge 90+

## Accessibility

- Semantic HTML structure
- ARIA labels where appropriate
- Keyboard navigation support
- Color contrast compliance
- Mobile-friendly touch targets

## License

MIT License — Same as AI Office framework

## Related

- [AI Office Framework](https://github.com/anthropics/ai-office)
- [Presentation Slides](../spectacle-slides/)
- [Documentation](https://github.com/anthropics/ai-office#readme)
