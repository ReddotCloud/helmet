Helmet
======


Templating
==========

Helmet supports templating on some strategic locations.

## Filters

All [liquidjs filters](https://shopify.github.io/liquid/filters/abs/) plus the ones below.

---

### `md5`

Template

> `{{ "helmet" | md5 }}`

Output

> `17b9183a08e7111fc6a38a4354fa6e92``

---

### `sha1`

Template

> `{{ "helmet" | sha1 }}`

Output

> `749440ec6a5039dc8c9a683c93ebc014b99cf1c1`

---

### `sha256`

Template

> `{{ "helmet" | sha256 }}`

Output

> `115584860cd5620e40fd03402e771e185a3f789038d1f70c9d651ee60580c3bb`

---

### `short`

Template

> `{{ "749440ec6a5039dc8c9a683c93ebc014b99cf1c1" | short }}`

Output

> `749440ec`

---

### `safe`

Template

> `{{ "feature/154-some-feature" | safe }}`

Output

> `feature_154-some-feature`

---

## Variables

```yaml
# User name
user: "root",

# Timestamp when the command was invoked
timestamp: "",

# The selected profile
profile:
  name: development

# Project information (only available on values templates)
project:
  image:

# Git information
git:
  commit: "4015b57a143aec5156fd1444a017a32137a3fd0f"
  tag: "1.0.0",
  dirty: true
  branch: feature/153-some-feature

# All environment variables plus
# the ones loaded from .env files (--load)
env:
  HOME: "..."

```
