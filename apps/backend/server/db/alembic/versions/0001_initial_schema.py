"""Initial multi-user schema.

Creates every table declared in server.db.models. Subsequent revisions
must use explicit op.* directives; this first one delegates to the ORM
metadata so the schema has a single definition.

Revision ID: 0001_initial
Revises:
Create Date: 2026-06-11
"""

from alembic import op
from server.db.models import Base

revision = "0001_initial"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    Base.metadata.create_all(bind=op.get_bind())


def downgrade() -> None:
    Base.metadata.drop_all(bind=op.get_bind())
