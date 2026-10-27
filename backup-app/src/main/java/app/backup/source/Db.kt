package app.backup.source

import android.content.Context
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Entity
import androidx.room.Index
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import androidx.room.Room
import androidx.room.RoomDatabase
import app.backup.core.PlainRecord
import app.backup.core.RecordType
import kotlinx.coroutines.flow.Flow
import org.json.JSONObject

/** syncState: 0 = بانتظار الرفع، 1 = رُفع وتأكّد الخادم من استلامه. */
@Entity(tableName = "records", indices = [Index("syncState"), Index("type")])
data class RecordEntity(
    @PrimaryKey val id: String,
    val type: String,
    val ts: Long,
    val json: String,
    val syncState: Int = 0,
    val createdAt: Long,
) {
    fun toPlain(deviceId: String) = PlainRecord(id, deviceId, RecordType.of(type), ts, JSONObject(json))
}

@Dao
interface RecordDao {
    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertAll(r: List<RecordEntity>): List<Long>

    @Query("SELECT * FROM records WHERE syncState = 0 ORDER BY ts ASC LIMIT :n")
    suspend fun pending(n: Int): List<RecordEntity>

    @Query("UPDATE records SET syncState = 1 WHERE id IN (:ids)")
    suspend fun markSynced(ids: List<String>)

    @Query("UPDATE records SET syncState = 0")
    suspend fun resetSync()

    @Query("SELECT COUNT(*) FROM records") fun total(): Flow<Int>
    @Query("SELECT COUNT(*) FROM records WHERE syncState = 0") fun pendingCount(): Flow<Int>
    @Query("SELECT COUNT(*) FROM records WHERE syncState = 0") suspend fun pendingNow(): Int

    @Query("SELECT * FROM records WHERE type = :type ORDER BY ts DESC LIMIT :n")
    fun recent(type: String, n: Int): Flow<List<RecordEntity>>

    @Query("DELETE FROM records WHERE id = :id") suspend fun delete(id: String)
    @Query("DELETE FROM records") suspend fun deleteAll()
}

@Database(entities = [RecordEntity::class], version = 1, exportSchema = false)
abstract class AppDb : RoomDatabase() {
    abstract fun dao(): RecordDao

    companion object {
        @Volatile private var inst: AppDb? = null
        fun get(ctx: Context): AppDb = inst ?: synchronized(this) {
            inst ?: Room.databaseBuilder(ctx.applicationContext, AppDb::class.java, "backup.db").build().also { inst = it }
        }
    }
}
