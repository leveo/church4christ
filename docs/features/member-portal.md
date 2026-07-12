# Member portal

## What it does

**My Portal** is the signed-in home for members. It builds on the people, households,
groups, events, teams, and gifts your church already manages, so members do not need a
second account or a separate app. They sign in with the same passwordless email link used
elsewhere in Church4Christ.

The portal is an optional module and requires the Supabase (Postgres) backend. On the
default Cloudflare D1 backend, its settings, navigation, and portal-only routes are hidden
entirely; the public site and volunteer schedule continue to work as usual.

## What members can do

### See and manage their household

Members see everyone in their household and can update their own profile. A household can
have up to two owners. Owners can update the household's members and details, request a
confirmed email-address change, and view the household's giving history; other members see
only their own giving.

### Take part in groups

The portal connects to the church's existing Groups module rather than creating a parallel
group system. Members can browse groups, request to join public groups, and see the groups
they belong to. Group administrators manage membership and can share files with group
members. Groups can be identified as fellowships or Sunday School classes and can carry
term information.

### Keep up with events and serving

The portal gathers a member's registrations, serving assignments, teams, and service
history in one place. A personal calendar combines serving assignments, group meetings,
registered events, and blockout dates. Members can subscribe to that calendar from Google
Calendar, Apple Calendar, or another calendar application.

### Share prayers in the right place

Members can post a prayer request to the whole church, one of their groups, an event they
are part of, or only themselves. Church-wide requests are moderated by church admins;
group requests by that group's administrators; and event requests by designated event
admins. Private requests are immediately visible only to their author.

## Setting it up

1. Configure the Supabase backend using [`docs/supabase-setup.md`](../supabase-setup.md).
2. In **Admin → Settings → Modules**, enable **Member Portal**.
3. In **Admin → People**, designate up to two eligible household members as owners.
4. Use **Admin → Groups** to maintain groups and group administrators. Event admins are
   managed from the relevant registration event.

Turning the module off removes the member-facing portal routes and controls without
deleting the underlying people, household, group, event, serving, giving, or prayer data.
