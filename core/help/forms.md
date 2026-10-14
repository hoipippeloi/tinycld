---
title: Forms and record types
summary: How a record's fields, pages and rules are defined and changed
tags: [forms, fields, rules, types]
order: 45
---

Some records, such as a task or a ticket, carry a **form**. The form decides
which fields the record shows, in what order, on which page, and which rules
apply. A record type is a form: a project can have a Task form and a Bug
form, and each record uses one of them. Forms belong to the organization, so
every member sees the same record types.

## Fields

A form has the record's **built-in fields** and any **custom fields** an
admin adds. A built-in field can be renamed, moved, hidden or given a
default, but not deleted. A custom field can be text, long text, a number, a
date, a toggle, a choice list, a person, a checklist, rich text, markdown or
a file.

Each field has a width: full, half, third or quarter of the form. On a narrow
screen a quarter becomes a half, and halves and thirds become full width.

## Pages

Fields are grouped into pages. When a record is created, the pages show one
at a time, with Next and Back. In a single-line field, press Enter to go to
the next page. In the record's detail view every page shows as a section.

## Rules

A rule reads one or more fields and changes the form: it can show or hide a
field or a page, make a field required, change the choices of a list, or set
a value. Rules run in order, once, on the current values. A rule cannot
trigger another rule, so rules never loop. A hidden field is never required.

## Defaults

A field can start with a fixed value, today's date, a date a number of days
from today, or the current user.

## Changing a record's type

Where the feature that owns the record offers it, open the record's actions menu and choose **Change type**.
Values for fields the new type does not have are kept but hidden; they show
again if the record returns to the old type or the new type gains that field.

Admins manage forms under Settings. See [Automation rules](help://core:rules)
for rules that run when records change, which are a different thing.

## Managing forms

An owner or admin opens **Settings → Forms**. With one record type the list opens directly; otherwise pick the record type first. The list shows every form of that type. Drag the handle to reorder the type selector, and use the menu on a row to rename, duplicate, make default, archive or delete a form. The default form cannot be deleted or archived; a form that records still use cannot be deleted, archive it instead.

## Editing a form

The editor shows the form as users see it. Select a field to edit its label, width, requirement, default and kind-specific settings in the panel. Drag a field by its handle to move it, also onto another page. **Add field** at the end of a page adds a field of the chosen kind and opens its panel. **Add page** appends a page; a page can be deleted only when it is empty.

A field's key is set when it is created and never changes, so renaming a field keeps its stored values. Deleting a custom field keeps the stored values hidden and removes any rule, default or requirement that named it; the editor says what it removed.

The **Rules** tab lists the form's rules. Each rule has conditions ("when all of" or "when any of") and actions. Pick a field, an operator and a value; then pick an action and its target. **Set options** is offered only for choice lists.

**Preview** opens the draft as users will see it, with rules live. **Save** writes the form; the server checks it again and points at any field it refuses. Save before leaving the editor: the Back arrow asks when there are unsaved changes, but the browser's own navigation does not.
