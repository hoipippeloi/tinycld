---
title: Forms and record types
summary: How a record's fields, pages and rules are defined and changed
tags: [forms, fields, rules, types]
order: 45
---

Some records, such as a task or a ticket, carry a **form**. The form decides
which fields the record shows, in what order, on which page, and which rules
apply. A record type is a form: a board can have a Card form and a Bug form,
and each card uses one of them.

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
at a time, with Next and Back. In the record's detail view every page shows
as a section.

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
