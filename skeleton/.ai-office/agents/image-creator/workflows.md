---
trigger: when_referenced
---
# Image Creator Workflows

## Owned Workflows

| Workflow | File | Purpose |
|----------|------|---------|
| `29_image_create` | `29_image_create.md` | Image creation workflow |

## Workflow Responsibilities

### 29_image_create

**Purpose:** Create image assets for projects

**Steps:**
1. Receive image requirements
2. Understand context and target platform
3. Create or generate images
4. Edit and optimize
5. Create variants (sizes, formats)
6. Add metadata and alt text
7. Document assets
8. Deliver for implementation

**Outputs:**
- Image files (multiple formats/sizes)
- Alt text descriptions
- Image documentation
- Asset metadata

## Workflow Interactions

### Triggers

| Workflow | Condition |
|----------|-----------|
| `40_dev_implement` | Image assets ready for implementation |
| `27_video_create` | Image assets ready for video |
| `25_design_ui` | Custom imagery ready |

### Receives From

| Workflow | Condition |
|----------|-----------|
| `25_design_ui` | Image requirements |
| `10_ceo_prd` | Image feature requirements |

## Document Ownership

Image Creator owns these artifacts:

| Artifact | Location | Purpose |
|----------|----------|---------|
| Image Assets | `assets/images/` | Image files |
| Image Documentation | `docs/images/<slug>-images.md` | Asset specifications |

## Image Deliverables

| Deliverable | Format | Purpose |
|-------------|--------|---------|
| Hero Images | WebP, AVIF, JPG | Landing pages, marketing |
| Product Images | WebP, JPG | E-commerce, catalogs |
| Illustrations | SVG, PNG | Custom visual content |
| Icons | SVG, PNG | UI elements |
| Social Images | JPG, PNG | Social media platforms |

## Collaboration Points

| Collaborator | Interaction |
|--------------|-------------|
| Designer | Visual style, brand alignment |
| Video Creator | Image assets for video |
| Developer | Image optimization, implementation |
| PM | Image requirements, messaging |
